import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { extractToObsidian, previewTarget, resolveYtDlp } from './lib/extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 预检：秒级元数据扫描，返回合集/视频清单供用户勾选，不执行提取
app.post('/api/preview', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: '请提供有效的 http(s) 链接' });
  }
  try {
    const preview = await previewTarget(url);
    res.json(preview);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/extract', async (req, res) => {
  const { url, limit, selection, skipSynced, creator } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: '请提供有效的 http(s) 链接' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let closed = false;
  // 注意：req 的 'close' 在请求体读完时就会触发（Node 18+），不能用来判断客户端断开；
  // 必须监听 res 的 'close'，且仅在响应尚未正常结束时才视为客户端提前断开。
  res.on('close', () => {
    if (!res.writableEnded) closed = true;
  });

  const sendUpdate = (status, message, data = {}) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify({ status, message, ...data })}\n\n`);
    } catch {}
  };

  // 心跳防止本地代理/浏览器把空闲连接掐断
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) {
      try {
        res.write(': ping\n\n');
      } catch {}
    }
  }, 15000);

  try {
    const result = await extractToObsidian({
      url,
      limit,
      selection,
      skipSynced: Boolean(skipSynced),
      creator,
      apiKey: process.env.AI_API_KEY,
      apiBase: process.env.AI_API_BASE,
      model: process.env.AI_MODEL,
      onUpdate: sendUpdate,
      shouldAbort: () => closed,
    });
    sendUpdate('success', `任务完成！成功 ${result.ok}/${result.total}，失败 ${result.fail}，已存入 Obsidian。`, {
      ok: result.ok,
      fail: result.fail,
      total: result.total,
    });
  } catch (error) {
    sendUpdate('error', `发生错误: ${error.message}`);
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

app.listen(port, () => {
  resolveYtDlp();
  console.log(`Server running at http://localhost:${port}`);
});
