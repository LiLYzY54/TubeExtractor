import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import pkg from 'yt-dlp-exec';
import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';
import fs from 'fs-extra';
import 'dotenv/config';

const DEFAULT_OUTPUT_DIR = '/Users/lilyzy/Documents/Obsidian/Daily_Thoughts/Inbox/Tubes';
const SUB_LANGS = process.env.SUB_LANGS || 'zh.*,ai_.*,en.*';
const SUB_FORMAT = 'srt/vtt/json/best';

// ---------- yt-dlp 解析与调用 ----------

let resolvedYtDlp = null;

export function resolveYtDlp() {
  if (resolvedYtDlp) return resolvedYtDlp;
  const candidates = [];
  try {
    candidates.push(execSync('command -v yt-dlp', { encoding: 'utf8' }).trim());
  } catch {}
  candidates.push(
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/opt/anaconda3/bin/yt-dlp',
    '/opt/miniconda3/bin/yt-dlp'
  );
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      resolvedYtDlp = pkg.create(p);
      console.log(`[yt-dlp] 使用系统版本: ${p}`);
      return resolvedYtDlp;
    }
  }
  resolvedYtDlp = pkg;
  console.log('[yt-dlp] 未找到系统版本，使用内置二进制（建议 brew install yt-dlp，或运行 npm run update-ytdlp）');
  return resolvedYtDlp;
}

function baseFlags(url, { cookies = true } = {}) {
  const flags = {
    noWarnings: true,
    noCheckCertificates: true,
    socketTimeout: 30,
    retries: 5,
  };
  if (cookies) flags.cookiesFromBrowser = 'chrome';
  if (url.includes('bilibili.com')) flags.addHeader = ['Referer:https://www.bilibili.com'];
  return flags;
}

function cleanYtDlpError(e) {
  const msg = [e.message, e.stderr].filter(Boolean).join(' ');
  const m = msg.match(/ERROR: (.+)/);
  const text = m ? m[1] : msg;
  return text.slice(0, 300).trim() || 'yt-dlp 调用失败';
}

// yt-dlp 在失败时可能往 stdout 输出字符串 "null"（配合 --ignore-no-formats-error 甚至 exit 0），
// 必须严格校验返回类型，否则会伪装成“没有视频”的假成功。
async function ytdlpJson(url, extra = {}) {
  const dl = resolveYtDlp();
  const attempt = async (withCookies) => {
    const flags = { ...baseFlags(url, { cookies: withCookies }), ...extra };
    const out = await dl(url, flags, { maxBuffer: 256 * 1024 * 1024 });
    if (typeof out !== 'object' || out === null) {
      throw new Error(
        out === 'null' || out === ''
          ? 'yt-dlp 未返回有效数据（可能被目标网站风控、需要登录或网络不通）'
          : `yt-dlp 返回异常输出: ${String(out).slice(0, 120)}`
      );
    }
    return out;
  };
  try {
    return await attempt(true);
  } catch (e) {
    if (/cookie/i.test(e.message || '')) {
      try {
        return await attempt(false);
      } catch (e2) {
        throw new Error(cleanYtDlpError(e2));
      }
    }
    throw new Error(cleanYtDlpError(e));
  }
}

// ---------- 链接与条目处理 ----------

function isSingleVideoUrl(u) {
  return /(?:youtube\.com\/(?:watch\?|shorts\/)|youtu\.be\/|bilibili\.com\/video\/)/.test(u);
}

function toEntries(metadata, inputUrl) {
  if (Array.isArray(metadata.entries)) {
    return metadata.entries.filter((e) => e && (e.url || e.id));
  }
  // 单视频链接：yt-dlp 返回的是视频对象本身，没有 entries 字段
  if (metadata.id) {
    const url = metadata.webpage_url || metadata.original_url || inputUrl;
    return [{ url, id: metadata.id, title: metadata.title }];
  }
  return [];
}

function normalizeEntryUrl(entry, sourceUrl) {
  const u = entry.url || entry.webpage_url || '';
  if (/^https?:\/\//i.test(u)) return u;
  const id = entry.id || u;
  if (/youtube\.com|youtu\.be/.test(sourceUrl)) return `https://www.youtube.com/watch?v=${id}`;
  if (/bilibili\.com/.test(sourceUrl)) return `https://www.bilibili.com/video/${id}`;
  return u || sourceUrl;
}

// ---------- 字幕提取（yt-dlp 落盘方案） ----------

// 字幕提取分两步：元数据用 -J 拿；字幕必须用【不带 -J】的独立调用下载——
// 实测 yt-dlp 在 --dump-single-json 模式下会完全跳过 --write-subs 的文件落盘。
// YouTube 近期对默认客户端的字幕下载要求 PO Token，拿不到时回退 web_embedded/tv_embedded 客户端。
const YT_SUB_CLIENT_FALLBACKS = ['web_embedded', 'tv_embedded'];

async function fetchTranscript(videoUrl, onUpdate = () => {}) {
  const dl = resolveYtDlp();
  const isYoutube = /youtube\.com|youtu\.be/.test(videoUrl);

  // 1) 元数据（标题/简介）
  const info = await ytdlpJson(videoUrl, {
    dumpSingleJson: true,
    skipDownload: true,
    ignoreNoFormatsError: true,
  });

  // 2) 字幕落盘（不带 -J）
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tube-subs-'));
  const readSubFiles = async () =>
    (await fs.readdir(tmpDir)).filter((f) => /\.(vtt|srt|json)$/i.test(f));

  const attempt = async (withCookies, playerClient) => {
    const flags = {
      ...baseFlags(videoUrl, { cookies: withCookies }),
      skipDownload: true,
      ignoreNoFormatsError: true,
      writeSubs: true,
      writeAutoSubs: true,
      subLangs: SUB_LANGS,
      subFormat: SUB_FORMAT,
      output: path.join(tmpDir, '%(id)s.%(ext)s'),
    };
    if (playerClient) flags.extractorArgs = `youtube:player_client=${playerClient}`;
    await dl.exec(videoUrl, flags, { maxBuffer: 64 * 1024 * 1024 });
  };

  try {
    let files = [];
    try {
      await attempt(true, null);
      files = await readSubFiles();
    } catch (e) {
      // 部分字幕可能已落盘（如个别语言 429），先收集再决定是否重试
      files = await readSubFiles();
      if (!files.length) {
        if (/cookie/i.test(e.message || '')) {
          try {
            await attempt(false, null);
            files = await readSubFiles();
          } catch {}
        } else if (!/429|too many requests/i.test(e.message || '')) {
          onUpdate('progress-detail', `字幕下载异常: ${cleanYtDlpError(e)}`);
        }
      }
    }

    if (!files.length && isYoutube) {
      for (const client of YT_SUB_CLIENT_FALLBACKS) {
        onUpdate('progress-detail', `默认客户端未取到字幕，尝试 player_client=${client} ...`);
        try {
          await attempt(true, client);
        } catch {}
        files = await readSubFiles();
        if (files.length) break;
      }
    }

    if (files.length) onUpdate('progress-detail', `已下载字幕文件: ${files.join(', ')}`);
    const transcript = await pickSubFile(tmpDir, files);
    return { info, transcript };
  } finally {
    await fs.remove(tmpDir).catch(() => {});
  }
}

// 优先级：简中 > ai_简中 > 繁中 > 中文 > 英文；同语言下 srt > vtt > json
async function pickSubFile(dir, files) {
  const langRank = (lang) => {
    const pri = ['zh-hans', 'zh-cn', 'ai_zh', 'zh-hant', 'zh-tw', 'zh', 'en-us', 'en-orig', 'en'];
    const l = (lang || '').toLowerCase();
    const idx = pri.findIndex((p) => l === p || l.startsWith(p + '-'));
    return idx === -1 ? 90 : idx;
  };
  const extRank = { srt: 0, vtt: 1, json: 2 };

  const scored = files
    .map((f) => {
      const parts = f.split('.');
      const ext = (parts.pop() || '').toLowerCase();
      const lang = parts.pop() || '';
      return { f, lang, ext, score: langRank(lang) * 10 + (extRank[ext] ?? 9) };
    })
    .sort((a, b) => a.score - b.score);

  let best = '';
  for (const s of scored) {
    const text = await parseSubFile(path.join(dir, s.f), s.ext);
    if (!text) continue;
    if (text.length >= 40) return text;
    if (text.length > best.length) best = text;
  }
  return best;
}

async function parseSubFile(file, ext) {
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
  let lines = [];
  if (ext === 'json') {
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data?.body)) {
        // B 站字幕 JSON: { body: [{ from, to, content }] }
        lines = data.body.map((it) => it?.content || '');
      } else if (Array.isArray(data?.events)) {
        // YouTube json3: { events: [{ segs: [{ utf8 }] }] }
        lines = data.events.flatMap((ev) => (ev.segs || []).map((sg) => sg?.utf8 || ''));
      }
    } catch {
      return '';
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (/^(WEBVTT|Kind:|Language:|NOTE)/i.test(t)) continue;
      if (/^\d+$/.test(t)) continue; // srt 序号
      if (t.includes('-->')) continue; // 时间轴
      lines.push(t);
    }
  }
  return lines
    .map((l) =>
      l
        .replace(/<[^>]+>/g, '')
        .replace(/\[[^\]]{0,40}\]/g, '')
        .replace(/[♪♫]/g, '')
        .trim()
    )
    .filter(Boolean)
    .filter((l, i, arr) => i === 0 || l !== arr[i - 1])
    .join('\n');
}

// ---------- 内容提取主路径 ----------

// ---------- ASR 语音转写兜底（OpenAI 兼容 /audio/transcriptions） ----------
// 兼容智谱 GLM-ASR（base: https://open.bigmodel.cn/api/paas/v4, model: glm-asr）
// 与 OpenAI Whisper（base: https://api.openai.com/v1, model: whisper-1）
function isAsrConfigured() {
  return Boolean(process.env.ASR_API_KEY && process.env.ASR_API_BASE);
}

async function hasFfmpeg() {
  try {
    execSync('command -v ffmpeg', { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

async function transcribeAudio(videoUrl, onUpdate = () => {}) {
  const dl = resolveYtDlp();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tube-asr-'));
  try {
    onUpdate('progress-detail', '未找到字幕轨，正在下载音频准备语音转写...');
    const flags = {
      ...baseFlags(videoUrl),
      // YouTube 在 PO Token 风控下可能没有独立音频轨，回退到音视频合并格式
      format: 'bestaudio/best',
      output: path.join(tmpDir, '%(id)s.%(ext)s'),
    };
    try {
      await dl.exec(videoUrl, flags, { maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      onUpdate('progress-detail', `音频下载失败: ${cleanYtDlpError(e)}`);
      return null;
    }
    const files = (await fs.readdir(tmpDir)).filter((f) => !f.startsWith('.'));
    if (!files.length) {
      onUpdate('progress-detail', '未获得音频文件，跳过语音转写');
      return null;
    }
    let audioPath = path.join(tmpDir, files[0]);
    const ffmpegOk = await hasFfmpeg();
    const isVideoContainer = /\.(mp4|webm|mkv|mov)$/i.test(audioPath);
    let size = (await fs.stat(audioPath)).size;

    // 下载到的是视频容器（如 YouTube 只剩合并格式）且有 ffmpeg → 抽取纯音频
    if (isVideoContainer && ffmpegOk) {
      onUpdate('progress-detail', '从视频容器中抽取音频轨...');
      const mp3 = audioPath.replace(/\.[^.]+$/, '') + '.mp3';
      try {
        execSync(`ffmpeg -y -i "${audioPath}" -vn -ac 1 -b:a 32k "${mp3}"`, { stdio: 'ignore' });
        audioPath = mp3;
        size = (await fs.stat(audioPath)).size;
      } catch {}
    }

    // 多数转写 API 限制 25MB：仍超限且有 ffmpeg 时继续压
    if (size > 25 * 1024 * 1024 && ffmpegOk) {
      onUpdate('progress-detail', '音频较大，使用 ffmpeg 压缩后转写...');
      const small = audioPath.replace(/\.mp3$/, '') + '.small.mp3';
      try {
        execSync(`ffmpeg -y -i "${audioPath}" -ac 1 -b:a 24k "${small}"`, { stdio: 'ignore' });
        audioPath = small;
        size = (await fs.stat(audioPath)).size;
      } catch {}
    }

    onUpdate('progress-detail', `正在上传音频进行语音转写 (${(size / 1024 / 1024).toFixed(1)}MB)...`);
    const base = process.env.ASR_API_BASE.replace(/\/+$/, '');
    const form = new FormData();
    form.append('file', new Blob([await fs.readFile(audioPath)]), path.basename(audioPath));
    form.append('model', process.env.ASR_MODEL || 'glm-asr');

    const resp = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.ASR_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(600000),
    });
    if (!resp.ok) {
      onUpdate('progress-detail', `语音转写失败: HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json().catch(() => ({}));
    const text = (data.text || data.content || '').trim();
    if (!text) {
      onUpdate('progress-detail', '语音转写返回空文本');
      return null;
    }

    // ASR 通常整段无换行：按句号切句、每 10 句合一段提升可读性
    const sentences = text.replace(/([。！？!?])/g, '$1\u0001').split('\u0001').map((s) => s.trim()).filter(Boolean);
    const paras = [];
    for (let i = 0; i < sentences.length; i += 10) {
      paras.push(sentences.slice(i, i + 10).join(''));
    }
    return paras.join('\n\n');
  } catch (e) {
    onUpdate('progress-detail', `语音转写异常: ${e.message}`);
    return null;
  } finally {
    await fs.remove(tmpDir).catch(() => {});
  }
}

// 视频页：标题 + 简介 + 字幕文稿（不再用 Defuddle，其 SSR 提取常被截断）。
// 无字幕轨时尝试 ASR 兜底；返回 transcriptStatus: 'subtitles' | 'asr' | false
async function videoPageText(videoUrl, onUpdate = () => {}) {
  onUpdate('progress-detail', '正在通过 yt-dlp 提取元数据与字幕...');
  const { info, transcript } = await fetchTranscript(videoUrl, onUpdate);

  let transcriptStatus = false;
  let transcriptSection = '\n## 视频文稿\n(未找到可用字幕轨)\n';

  if (transcript) {
    transcriptStatus = 'subtitles';
    transcriptSection = `\n## 视频文稿\n${transcript}\n`;
  } else if (isAsrConfigured()) {
    const asrText = await transcribeAudio(videoUrl, onUpdate);
    if (asrText) {
      transcriptStatus = 'asr';
      transcriptSection = `\n## 视频文稿（语音转写）\n${asrText}\n`;
    }
  }

  const text = `# ${info.title || ''}\n\n## 简介\n${(info.description || '').trim() || '无简介'}\n${transcriptSection}`;
  return { text, transcriptStatus };
}

// 非视频页（文章/专栏等）：Defuddle 正文提取，内容过短视为失败
async function articleContent(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    if (!response.ok) return '';
    const html = await response.text();
    const { document } = parseHTML(html);
    const result = await Defuddle(document, url, { markdown: true });
    return result.content || '';
  } catch {
    return '';
  }
}

// ---------- AI 总结 ----------

export async function summarizeWithLLM(text, apiKey, apiBase, model) {
  if (!apiKey) return '未提供 API Key，跳过总结。';

  const base = (apiBase || process.env.AI_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const useModel = model || process.env.AI_MODEL || 'gpt-4o-mini';

  // 长文截断：保留开头主体 + 结尾（结论通常在结尾），DeepSeek 64k 上下文下 3 万字符很宽裕
  let content = text.trim();
  if (content.length > 30000) {
    content = content.slice(0, 22000) + '\n\n……[中间部分过长已截断]……\n\n' + content.slice(-6000);
  }

  const system = `你是一个专业的视频内容分析助手。基于给定的视频标题、简介与文稿，输出结构化 Markdown 总结，包含以下章节：

## 一句话概括
## 核心观点
（3-7 条，保留关键论据、数据与案例）
## 可执行操作路径
（若视频包含方法、步骤、清单或建议，整理为带编号的可执行步骤；若没有明确方法，给出 1-3 条"如何应用这些内容"的具体建议）
## 存疑与补充
（可选：信息缺口或文稿中无法确认的部分）

规则：
- 只基于给定内容，不要编造。
- 文稿可能来自语音转写，可能存在错别字或标点缺失，归纳时按语义理解，不要逐字引用可疑片段。
- 若文稿缺失或极短，必须明确说明"文稿缺失，以下仅基于标题与简介总结"，此时"可执行操作路径"改为给出观看/查证建议。
- 使用中文输出。`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: useModel,
        max_tokens: 4000,
        temperature: 0.3,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `请分析并总结以下视频内容：\n\n${content}` },
        ],
      }),
    });

    if (!response.ok) {
      let msg = response.statusText;
      try {
        const errData = await response.json();
        msg = errData.error?.message || msg;
      } catch {}
      return `AI 总结失败: ${msg}`;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || 'AI 总结失败: 响应中没有内容';
  } catch (err) {
    return `AI 总结发生错误: ${err.message}`;
  }
}

// ---------- 文件名与 Markdown ----------

export function sanitizeFilename(name, maxLen = 120) {
  const cleaned = String(name ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .slice(0, maxLen)
    .replace(/[.\s]+$/, '')
    .trim();
  return cleaned || 'Untitled';
}

async function uniqueName(dir, base) {
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let name = base;
  let n = 2;
  while (await fs.pathExists(path.join(dir, name))) {
    name = `${stem} (${n++})${ext}`;
  }
  return name;
}

// 从简介/正文中提取外部资源链接（去重、排除源链接本身），PDF 优先标注
function extractResources(text, sourceUrl) {
  const raw = String(text || '').match(/https?:\/\/[^\s，。；、）)】"']+/g) || [];
  const seen = new Set();
  const out = [];
  for (const u of raw) {
    const url = u.replace(/[.,;:：]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    let sameSource = false;
    let label = url;
    try {
      const a = new URL(url);
      const b = sourceUrl ? new URL(sourceUrl) : null;
      sameSource = b && a.host === b.host && a.pathname === b.pathname;
      label = a.host;
    } catch {}
    if (sameSource) continue;
    if (/\.pdf(\?|#|$)/i.test(url)) label = 'PDF 文档';
    out.push({ url, label });
  }
  return out;
}

function yamlQuote(v) {
  return `"${String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// transcriptStatus: 'subtitles' | 'asr' | 'article' | false
function buildMarkdown({ videoUrl, creator, title, summary, content, resources = [], transcriptStatus = 'subtitles' }) {
  const transcriptLine = transcriptStatus === false ? 'false' : `"${transcriptStatus}"`;

  const resourcesSection = resources.length
    ? `## 🔗 配套资料

${resources.map((r) => `- [${r.label}](${r.url})`).join('\n')}

`
    : '';

  const summarySection =
    transcriptStatus === false
      ? `## 🗂️ 来源卡片

> ⚠️ **未能提取到文稿**（无字幕轨，语音转写未配置或未成功），本笔记仅记录来源信息，**不做内容总结**——以下不包含任何"核心观点"，避免以简介冒充视频内容。
> 补救：配置 \`ASR_API_KEY\` / \`ASR_API_BASE\` / \`ASR_MODEL\` 后对同链接重新运行本工具即可自动转写并总结；或直接观看原视频 / 查阅配套资料。
`
      : `## 🤖 AI 总结

${summary || '未生成总结（未配置 AI Key 或已跳过）'}
`;

  return `---
source: ${videoUrl}
creator: ${yamlQuote(creator)}
title: ${yamlQuote(title)}
transcript: ${transcriptLine}
extracted_at: ${new Date().toISOString()}
---

# ${title}

${summarySection}
${resourcesSection}---

## 📄 原始提取内容

${content}
`;
}

// ---------- 预检层：增量标记 / 合集枚举 / 选择展开 ----------

const BILI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function biliApiHeaders() {
  return { 'User-Agent': BILI_UA, Referer: 'https://space.bilibili.com/' };
}

// 遍历输出目录，收集所有笔记 frontmatter 里的 source URL（增量同步的基础）
export async function scanSyncedUrls(baseDir) {
  const synced = new Set();
  const walk = async (dir) => {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) await walk(p);
      else if (it.name.endsWith('.md')) {
        try {
          const head = (await fs.readFile(p, 'utf8')).slice(0, 600);
          const m = head.match(/^source:\s*(\S+)/m);
          if (m) synced.add(m[1]);
        } catch {}
      }
    }
  };
  await walk(baseDir);
  return synced;
}

// B 站合集（season）与系列（series）枚举
async function biliListCollections(mid) {
  const out = [];
  for (const kind of ['seasons', 'series']) {
    const listKey = kind === 'seasons' ? 'seasons_list' : 'series_list';
    for (let page = 1; page <= 5; page++) {
      const u = `https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid=${mid}&page_num=${page}&page_size=20`;
      const resp = await fetch(u, { headers: biliApiHeaders(), signal: AbortSignal.timeout(15000) });
      if (!resp.ok) break;
      const d = await resp.json().catch(() => null);
      const items = ((d?.data?.items_lists || {})[listKey] || []);
      for (const s of items) {
        const meta = s.meta || {};
        const id = String(meta.season_id ?? meta.series_id ?? '');
        if (!id) continue;
        out.push({
          kind: kind === 'seasons' ? 'bili-season' : 'bili-series',
          id,
          mid: String(mid),
          title: meta.name || '未命名合集',
          count: meta.total ?? null,
        });
      }
      if (items.length < 20) break;
    }
  }
  return out;
}

// B 站用户名（合集 API 不返回昵称，用卡片接口兜底）
async function biliUserName(mid) {
  try {
    const resp = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${mid}`, {
      headers: biliApiHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    const d = await resp.json().catch(() => null);
    return d?.data?.card?.name || '';
  } catch {
    return '';
  }
}

// 拉取某个 B 站合集/系列内的全部视频
async function biliListArchives(col) {
  const out = [];
  const isSeason = col.kind === 'bili-season';
  for (let page = 1; page <= 20; page++) {
    const u = isSeason
      ? `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${col.mid}&season_id=${col.id}&page_num=${page}&page_size=30`
      : `https://api.bilibili.com/x/series/archives?mid=${col.mid}&series_id=${col.id}&pn=${page}&ps=30`;
    const resp = await fetch(u, { headers: biliApiHeaders(), signal: AbortSignal.timeout(15000) });
    if (!resp.ok) break;
    const d = await resp.json().catch(() => null);
    const archives = d?.data?.archives || [];
    for (const a of archives) {
      if (a?.bvid) out.push({ url: `https://www.bilibili.com/video/${a.bvid}`, title: a.title || '' });
    }
    const total = d?.data?.page?.total ?? out.length;
    if (!archives.length || out.length >= total) break;
  }
  return out;
}

function ytChannelBase(u) {
  return u
    .replace(/\/(videos|shorts|streams|playlists|featured|community|about|live|podcasts)(\/.*)?(\?.*)?$/i, '')
    .replace(/\?.*$/, '')
    .replace(/\/$/, '');
}

async function ytListCollections(channelBase) {
  try {
    const meta = await ytdlpJson(channelBase + '/playlists', {
      dumpSingleJson: true,
      flatPlaylist: true,
      // --playlist-items 用区间语法：单个数字含义是"只取第 N 项"
      playlistItems: '1-30',
    });
    return (meta.entries || [])
      .filter((e) => e && e.url)
      .slice(0, 30)
      .map((e) => ({
        kind: 'yt-playlist',
        url: e.url,
        title: e.title || '未命名合集',
        count: e.playlist_count ?? null,
      }));
  } catch {
    return [];
  }
}

async function ytListVideos(listUrl, cap = 60) {
  try {
    const meta = await ytdlpJson(listUrl, {
      dumpSingleJson: true,
      flatPlaylist: true,
      playlistItems: `1-${cap}`,
    });
    return (meta.entries || [])
      .filter((e) => e && e.url)
      .slice(0, cap)
      .map((e) => ({ url: normalizeEntryUrl(e, listUrl), title: e.title || '' }));
  } catch {
    return [];
  }
}

function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/bilibili\.com/.test(url)) return 'bilibili';
  return 'other';
}

const previewCache = new Map();

// 预检：秒级 flat 元数据扫描 + 合集枚举 + 增量标记，不下载任何内容
export async function previewTarget(url) {
  const cached = previewCache.get(url);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.data;

  const baseDir = process.env.OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
  const withSynced = async (videos) => {
    const synced = await scanSyncedUrls(baseDir);
    return { syncTotal: synced.size, videos: videos.map((v) => ({ ...v, synced: synced.has(v.url) })) };
  };

  let result;

  if (isSingleVideoUrl(url)) {
    // 单视频链接：flat 扫描判定是否多 P（如 B 站分P 教程）
    const meta = await ytdlpJson(url, { dumpSingleJson: true, flatPlaylist: true });
    const entries = toEntries(meta, url);
    if (entries.length > 1) {
      const { videos, syncTotal } = await withSynced(
        entries.slice(0, 100).map((e) => ({ url: normalizeEntryUrl(e, url), title: e.title || '' })),
      );
      result = {
        mode: 'videos',
        creator: meta.uploader || meta.channel || meta.title || 'Unknown',
        platform: detectPlatform(url),
        collections: [],
        videos,
        syncTotal,
      };
    } else {
      result = {
        mode: 'single',
        creator: meta.uploader || meta.channel || '',
        platform: detectPlatform(url),
        collections: [],
        videos: [{ url: meta.webpage_url || url, title: meta.title || '', synced: false }],
        syncTotal: 0,
      };
    }
  } else if (/youtube\.com|youtu\.be/.test(url)) {
    const base = ytChannelBase(url);
    const meta = await ytdlpJson(base, { dumpSingleJson: true, flatPlaylist: true });
    const creator =
      meta.uploader || meta.channel || String(meta.title || '').replace(/ - YouTube$/, '') || 'Unknown';
    const [collections, videos] = await Promise.all([ytListCollections(base), ytListVideos(base + '/videos')]);
    const { videos: marked, syncTotal } = await withSynced(videos);
    result = {
      mode: collections.length ? 'collections' : videos.length ? 'videos' : 'single',
      creator,
      platform: 'youtube',
      collections,
      videos: marked,
      syncTotal,
    };
  } else if (/space\.bilibili\.com/.test(url)) {
    const mid = url.match(/space\.bilibili\.com\/(\d+)/)?.[1];
    if (!mid) throw new Error('无法从链接中解析 B 站用户 ID');
    const meta = await ytdlpJson(`https://space.bilibili.com/${mid}/video`, {
      dumpSingleJson: true,
      flatPlaylist: true,
      playlistItems: '1-60',
    });
    const creator =
      meta.uploader || meta.channel || (await biliUserName(mid)) || `bilibili 用户 ${mid}`;
    const videos = (meta.entries || [])
      .filter((e) => e && e.url)
      .slice(0, 60)
      .map((e) => ({ url: normalizeEntryUrl(e, url), title: e.title || '' }));
    const [collections, marked] = await Promise.all([biliListCollections(mid), withSynced(videos)]);
    result = {
      mode: collections.length ? 'collections' : marked.videos.length ? 'videos' : 'single',
      creator,
      platform: 'bilibili',
      collections,
      videos: marked.videos,
      syncTotal: marked.syncTotal,
    };
  } else {
    const meta = await ytdlpJson(url, { dumpSingleJson: true, flatPlaylist: true });
    const entries = toEntries(meta, url);
    if (entries.length > 1) {
      const { videos, syncTotal } = await withSynced(
        entries.slice(0, 100).map((e) => ({ url: normalizeEntryUrl(e, url), title: e.title || '' })),
      );
      result = {
        mode: 'videos',
        creator: meta.uploader || meta.channel || meta.title || 'Unknown',
        platform: detectPlatform(url),
        collections: [],
        videos,
        syncTotal,
      };
    } else {
      result = {
        mode: 'single',
        creator: meta.uploader || meta.channel || '',
        platform: detectPlatform(url),
        collections: [],
        videos: [{ url, title: meta.title || '', synced: false }],
        syncTotal: 0,
      };
    }
  }

  previewCache.set(url, { at: Date.now(), data: result });
  return result;
}

// 把用户的选择（合集 + 手动视频）展开为待执行的 URL 清单
export async function expandSelection(selection) {
  const seen = new Set();
  const entries = [];
  const push = (url, title) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    entries.push({ url, title: title || '' });
  };

  for (const col of selection.collections || []) {
    try {
      if (col.kind === 'yt-playlist') {
        const meta = await ytdlpJson(col.url, { dumpSingleJson: true, flatPlaylist: true });
        for (const e of meta.entries || []) if (e) push(normalizeEntryUrl(e, col.url), e.title);
      } else if (col.kind === 'bili-season' || col.kind === 'bili-series') {
        for (const a of await biliListArchives(col)) push(a.url, a.title);
      }
    } catch (e) {
      // 单个合集展开失败不阻塞其余合集，执行时以清单为准
      console.error(`展开合集失败 (${col.title}): ${e.message}`);
    }
  }
  for (const v of selection.videos || []) {
    if (typeof v === 'string') push(v, '');
    else push(v.url, v.title);
  }
  return entries;
}

// ---------- 主流程 ----------

export async function extractToObsidian({
  url,
  limit,
  apiKey,
  apiBase,
  model,
  outputDir,
  selection,
  skipSynced,
  creator: creatorHint,
  onUpdate = () => {},
  shouldAbort = () => false,
}) {
  const baseDir = outputDir || process.env.OUTPUT_DIR || DEFAULT_OUTPUT_DIR;

  onUpdate('loading', `正在解析: ${url} ...`);

  let list;
  let rawCreator;
  let sourceCount;

  const hasSelection = Boolean(
    selection && ((selection.collections || []).length || (selection.videos || []).length),
  );
  if (hasSelection) {
    // 预检-选择模式：执行清单来自用户勾选的合集/视频，无需再扫描主页
    list = await expandSelection(selection);
    rawCreator = creatorHint || 'Unknown_Creator';
    sourceCount = list.length;
    if (!list.length) {
      throw new Error('所选合集未能展开出任何视频（合集可能为空、已失效或网络受限）');
    }
  } else {
    const metadata = await ytdlpJson(url, { dumpSingleJson: true, flatPlaylist: true });
    const entries = toEntries(metadata, url);
    if (!entries.length) {
      throw new Error('该链接未解析出可处理的视频（链接类型不支持、内容不可访问或已被删除）');
    }
    list = entries.map((e) => ({ url: normalizeEntryUrl(e, url), title: e.title || `Video_` }));
    sourceCount = list.length;
    rawCreator =
      metadata.uploader ||
      metadata.channel ||
      String(metadata.title || '').replace(/ - YouTube$/, '') ||
      'Unknown_Creator';
  }

  if (skipSynced) {
    const synced = await scanSyncedUrls(baseDir);
    const before = list.length;
    list = list.filter((e) => !synced.has(e.url));
    if (list.length < before) {
      onUpdate('info', `增量模式：跳过 ${before - list.length} 个已同步视频。`);
    }
    if (!list.length) {
      throw new Error('所选视频均已同步至 Obsidian，无待处理内容（可关闭"跳过已同步"强制重跑）');
    }
  }

  if (Number.isFinite(limit) && limit > 0 && list.length > limit) {
    list = list.slice(0, limit);
  }
  const creatorFolder = sanitizeFilename(rawCreator, 80);

  onUpdate('info', `找到博主: ${rawCreator}，本次处理 ${list.length} 个视频（源共 ${sourceCount} 个）。`, {
    creator: rawCreator,
    count: list.length,
    total: sourceCount,
  });

  const creatorPath = path.join(baseDir, creatorFolder);
  await fs.ensureDir(creatorPath);

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < list.length; i++) {
    if (shouldAbort()) {
      onUpdate('warning', '检测到客户端已断开，任务中止。');
      break;
    }

    const entry = list[i];
    const videoUrl = normalizeEntryUrl(entry, url);
    const videoTitle = entry.title || `Video_${i + 1}`;

    onUpdate('progress', `正在处理 (${i + 1}/${list.length}): ${videoTitle}`, {
      current: i + 1,
      total: list.length,
      title: videoTitle,
      url: videoUrl,
    });

    try {
      // 视频页直接走字幕管线（Defuddle 对视频页的 SSR 提取不完整）；仅非视频链接先用正文提取
      let content = '';
      let transcriptStatus = 'article'; // 文章正文视为内容完备，正常走 AI 总结
      if (!isSingleVideoUrl(videoUrl)) content = await articleContent(videoUrl);
      if (!content || content.length < 200) {
        const r = await videoPageText(videoUrl, onUpdate);
        content = r.text;
        transcriptStatus = r.transcriptStatus; // 'subtitles' | 'asr' | false
      }

      let summary = '';
      if (transcriptStatus === false) {
        // 无文稿：不调用 AI，避免"简介改写"冒充核心观点（降级为来源卡片）
        onUpdate('progress-detail', '无文稿可用，跳过 AI 总结，按来源卡片生成');
      } else if (apiKey) {
        onUpdate('progress-detail', '正在请求 AI 总结...', { url: videoUrl });
        summary = await summarizeWithLLM(content, apiKey, apiBase, model);
      }

      const resources = extractResources(content, videoUrl);
      const md = buildMarkdown({
        videoUrl,
        creator: rawCreator,
        title: videoTitle,
        summary,
        content,
        resources,
        transcriptStatus,
      });

      const fileName = await uniqueName(creatorPath, `${sanitizeFilename(videoTitle, 120)}.md`);
      await fs.writeFile(path.join(creatorPath, fileName), md);
      ok++;
      onUpdate('item-done', `已保存: ${fileName}`, { title: videoTitle, url: videoUrl });
    } catch (err) {
      fail++;
      onUpdate('warning', `无法处理视频 ${videoUrl}: ${err.message}`, { title: videoTitle, url: videoUrl });
    }
  }

  return { creator: rawCreator, total: list.length, ok, fail };
}
