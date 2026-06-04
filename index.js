import pkg from 'yt-dlp-exec';
const youtubeDl = pkg;
import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';
import fs from 'fs-extra';
import path from 'path';
import { program } from 'commander';
import 'dotenv/config';
import TranscriptClient from 'youtube-transcript-api';

const OBSIDIAN_BASE_PATH = '/Users/lilyzy/Documents/Obsidian/Daily_Thoughts/Inbox/Tubes';

program
  .name('tube-extractor')
  .description('Extract video content from a creator\'s profile to Obsidian')
  .argument('<url>', 'The profile URL')
  .option('-l, --limit <number>', 'Limit the number of videos', parseInt)
  .option('-k, --key <string>', 'AI API Key')
  .option('-b, --base <string>', 'AI Base URL')
  .action(async (url, options) => {
    try {
      console.log(`[*] 正在解析主页: ${url}...`);
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
      if (options.limit && entries.length > options.limit) {
        entries = entries.slice(0, options.limit);
      }

      // Fix Unknown_Creator
      let creatorName = metadata.uploader || metadata.channel || metadata.title;
      if ((!creatorName || creatorName === 'null') && entries.length > 0) {
        creatorName = entries[0].uploader || entries[0].channel || 'Unknown_Creator';
      } else {
        creatorName = creatorName || 'Unknown_Creator';
      }

      console.log(`[+] 找到博主: ${creatorName}, 共有 ${entries.length} 个视频。`);

      const creatorPath = path.join(OBSIDIAN_BASE_PATH, sanitizeFilename(creatorName));
      await fs.ensureDir(creatorPath);

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const videoUrl = entry.url;
        const videoTitle = entry.title || `Video_${i}`;
        console.log(`[${i + 1}/${entries.length}] 正在处理: ${videoTitle}`);

        const rawContent = await extractContent(videoUrl);
        
        let summary = '';
        if (options.key) {
          console.log(`    正在请求 AI 总结...`);
          summary = await summarizeWithLLM(rawContent, options.key, options.base);
        }

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

        const filePath = path.join(creatorPath, `${sanitizeFilename(videoTitle)}.md`);
        await fs.writeFile(filePath, finalContent);
      }
      console.log('[✔] 任务完成！');
    } catch (error) {
      console.error(`[❌] 错误: ${error.message}`);
    }
  });

async function extractContent(url) {
  let content = '';
  try {
    const response = await fetch(url);
    if (response.ok) {
      const html = await response.text();
      const { document } = parseHTML(html);
      const result = await Defuddle(document, url, { markdown: true });
      content = result.content || '';
    }
  } catch (e) {}

  if (!content || content.length < 200) {
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
    if (url.includes('bilibili.com')) {
      ytDlpOptions.addHeader = ['Referer:https://www.bilibili.com'];
    }

    const info = await youtubeDl(url, ytDlpOptions);

    let text = `# ${info.title || ''}\n\n`;
    text += `## 简介\n${info.description || '无简介'}\n\n`;
    
    let transcript = '';
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
      } catch (e) {}
    }

    if (!transcript) {
      const subs = info.requested_subtitles || info.subtitles || info.automatic_captions || {};
      const langKeys = ['zh-CN', 'zh-Hans', 'zh', 'en'];
      let subUrl = null;
      for (const lang of langKeys) {
        if (subs[lang] && subs[lang].length > 0) {
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
              transcript = rawSub.replace(/<[^>]+>/g, '').split('\n').filter(l => !l.includes('-->') && l.trim()).join('\n');
            }
          }
        } catch (e) {}
      }
    }

    if (transcript) text += `## 视频文稿\n${transcript}\n\n`;
    return text;
  } catch (err) {
    return `[提取失败]: ${err.message}`;
  }
}

async function summarizeWithLLM(text, apiKey, apiBase) {
  const base = apiBase || 'https://api.openai.com/v1';
  const url = `${base.replace(/\/$/, '')}/chat/completions`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "你是一个专业的视频内容分析助手。总结核心内容和关键观点。" },
          { role: "user", content: `请总结：\n\n${text.slice(0, 4000)}` }
        ]
      })
    });
    const data = await response.json();
    return data.choices[0].message.content;
  } catch (err) {
    return `AI 总结失败: ${err.message}`;
  }
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

program.parse();
