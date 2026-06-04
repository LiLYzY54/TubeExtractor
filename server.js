import express from 'express';
import cors from 'cors';
import pkg from 'yt-dlp-exec';
const youtubeDl = pkg;
import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';
import fs from 'fs-extra';
import path from 'path';
import 'dotenv/config';
import TranscriptClient from 'youtube-transcript-api';

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const OBSIDIAN_BASE_PATH = '/Users/lilyzy/Documents/Obsidian/Daily_Thoughts/Inbox/Tubes';

app.post('/api/extract', async (req, res) => {
  const { url, limit } = req.body;
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendUpdate = (status, message, data = {}) => {
    res.write(`data: ${JSON.stringify({ status, message, ...data })}\n\n`);
  };

  try {
    sendUpdate('loading', `正在解析主页: ${url}...`);

    const ytDlpOptions = {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      cookiesFromBrowser: 'chrome',
    };

    if (url.includes('bilibili.com')) {
      ytDlpOptions.addHeader = ['Referer:https://www.bilibili.com'];
    }

    const metadata = await youtubeDl(url, ytDlpOptions);

    let entries = (metadata.entries || []).filter(e => e && e.url);
    if (limit && entries.length > limit) {
      entries = entries.slice(0, limit);
    }

    // 修复 Unknown_Creator 问题：如果主页没有名字，从第一个视频获取
    let creatorName = metadata.uploader || metadata.channel || metadata.title;
    if ((!creatorName || creatorName === 'null') && entries.length > 0) {
      creatorName = entries[0].uploader || entries[0].channel || 'Unknown_Creator';
    } else {
      creatorName = creatorName || 'Unknown_Creator';
    }

    sendUpdate('info', `找到博主: ${creatorName}, 共有 ${entries.length} 个视频。`, { creator: creatorName, count: entries.length });

    const creatorPath = path.join(OBSIDIAN_BASE_PATH, sanitizeFilename(creatorName));
    await fs.ensureDir(creatorPath);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const videoUrl = entry.url;
      const videoTitle = entry.title || `Video_${i}`;
      
      sendUpdate('progress', `正在处理 (${i + 1}/${entries.length}): ${videoTitle}`, { current: i + 1, total: entries.length, title: videoTitle });

      try {
        // 1. 混合提取内容 (Defuddle -> yt-dlp)
        const rawContent = await extractContent(videoUrl, sendUpdate);
        
        // 2. AI 总结
        let summary = '';
        if (apiKey) {
          sendUpdate('progress-detail', `正在请求 AI 总结: ${videoTitle}...`);
          summary = await summarizeWithLLM(rawContent, apiKey, apiBase);
        }

        const fileName = `${sanitizeFilename(videoTitle)}.md`;
        const filePath = path.join(creatorPath, fileName);

        const finalContent = `---
source: ${videoUrl}
creator: ${creatorName}
extracted_at: ${new Date().toISOString()}
---

# ${videoTitle}

## 🤖 AI 总结
${summary || '未生成总结'}

---

## 📄 原始提取内容
${rawContent}
`;

        await fs.writeFile(filePath, finalContent);
      } catch (err) {
        sendUpdate('warning', `无法处理视频 ${videoUrl}: ${err.message}`);
      }
    }

    sendUpdate('success', '任务完成！已全部存入 Obsidian。');
    res.end();
  } catch (error) {
    sendUpdate('error', `发生错误: ${error.message}`);
    res.end();
  }
});

async function extractContent(url, sendUpdate) {
  let content = '';
  try {
    sendUpdate('progress-detail', '尝试使用 Defuddle 提取...');
    const response = await fetch(url);
    if (response.ok) {
      const html = await response.text();
      const { document } = parseHTML(html);
      const result = await Defuddle(document, url, { markdown: true });
      content = result.content || '';
    }
  } catch (e) {
    console.error('Defuddle failed:', e.message);
  }

  // 如果 Defuddle 失败或内容过短，降级到 yt-dlp
  if (!content || content.length < 200) {
    sendUpdate('progress-detail', 'Defuddle 内容不足或失败，降级使用 yt-dlp 提取文稿...');
    content = await ytDlpFallback(url);
  }

  return content;
}

async function ytDlpFallback(url) {
  try {
    const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
    
    const ytDlpOptions = {
      dumpSingleJson: true,
      skipDownload: true,
      ignoreNoFormatsError: true,
      cookiesFromBrowser: 'chrome',
      noCheckCertificates: true,
    };

    // 只有 B站 才加 Referer 头部，YouTube 加了反而可能报错
    if (url.includes('bilibili.com')) {
      ytDlpOptions.addHeader = ['Referer:https://www.bilibili.com'];
    }

    const info = await youtubeDl(url, ytDlpOptions);

    let text = `# ${info.title || ''}\n\n`;
    text += `## 简介\n${info.description || '无简介'}\n\n`;
    
    let transcript = '';

    // 如果是 YouTube，优先尝试专用库获取字幕
    if (isYoutube) {
      try {
        const videoId = info.id || url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/)?.[1];
        if (videoId) {
          const client = new TranscriptClient();
          await client.ready;
          const transcriptData = await client.getTranscript(videoId);
          if (transcriptData && transcriptData.segments) {
            transcript = transcriptData.segments.map(item => {
              const time = Math.floor(item.startMs / 1000);
              const m = Math.floor(time / 60);
              const s = time % 60;
              return `[${m}:${s.toString().padStart(2, '0')}] ${item.text}`;
            }).join('\n');
          }
        }
      } catch (e) {
        console.error('youtube-transcript-api failed:', e.message);
      }
    }

    // 如果 transcript 还是空的（或者是 B站），尝试用 yt-dlp 的逻辑
    if (!transcript) {
      const subs = info.requested_subtitles || info.subtitles || info.automatic_captions || {};
      const langKeys = ['zh-CN', 'zh-Hans', 'zh', 'en', 'en-US'];
      let subUrl = null;

      for (const lang of langKeys) {
        if (subs[lang] && subs[lang].length > 0) {
          // 查找 json 格式或 srv 格式
          const preferred = subs[lang].find(s => s.ext === 'json') || subs[lang][0];
          subUrl = preferred.url;
          break;
        }
      }

      if (subUrl) {
        try {
          const subRes = await fetch(subUrl);
          if (subRes.ok) {
            const contentType = subRes.headers.get('content-type');
            if (contentType && contentType.includes('json')) {
               const subData = await subRes.json();
               if (subData.body && Array.isArray(subData.body)) {
                 transcript = subData.body.map(item => {
                   const time = Math.floor(item.from);
                   const m = Math.floor(time / 60);
                   const s = time % 60;
                   return `[${m}:${s.toString().padStart(2, '0')}] ${item.content}`;
                 }).join('\n');
               }
            } else {
               const rawSub = await subRes.text();
               // 简单清理 XML/VTT 标签
               transcript = rawSub.replace(/<[^>]+>/g, '').split('\n').filter(l => !l.includes('-->') && l.trim()).join('\n');
            }
          }
        } catch (e) {
          console.error('Manual sub fetch failed:', e.message);
        }
      }
    }

    text += `## 视频文稿\n${transcript || '(未找到可用字幕)'}\n\n`;
    return text;
  } catch (err) {
    return `[提取失败]: ${err.message}`;
  }
}

async function summarizeWithLLM(text, apiKey, apiBase) {
  if (!apiKey) return "未提供 API Key，跳过总结。";
  
  const base = apiBase || 'https://api.openai.com/v1';
  const url = `${base.replace(/\/$/, '')}/chat/completions`;

  try {
    // 截断文本以防超出上下文限制 (约 4000 字符)
    const truncatedText = text.slice(0, 4000);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "你是一个专业的视频内容分析助手。请根据提供的视频标题、简介和内容片段，总结出视频的核心内容和关键观点。输出格式为 Markdown。" },
          { role: "user", content: `请总结以下内容：\n\n${truncatedText}` }
        ]
      })
    });

    if (!response.ok) {
      const errData = await response.json();
      return `AI 总结失败: ${errData.error?.message || response.statusText}`;
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (err) {
    return `AI 总结发生错误: ${err.message}`;
  }
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
