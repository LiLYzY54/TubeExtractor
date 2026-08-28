# TubeExtractor

从单个视频或博主主页链接，自动提取视频内容（标题 / 简介 / 字幕文稿），经 AI 总结出核心观点与**可执行操作路径**，生成 Markdown 存入 Obsidian。

## 功能

- 支持粘贴**单个视频链接**或**博主主页链接**（YouTube / Bilibili 等 yt-dlp 支持的平台）。
- 自动提取视频字幕轨（含人工字幕、自动字幕、B 站 AI 字幕、YouTube 自动翻译字幕），清理成纯文本文稿。
- **无字幕时自动语音转写（ASR）兜底**：下载音频轨调用转写 API（智谱 GLM-ASR / OpenAI Whisper 等兼容接口）。
- AI 结构化总结：一句话概括 / 核心观点 / 可执行操作路径 / 存疑与补充。
- 无文稿且未配置转写时降级为「来源卡片」：不调用 AI、不产出伪总结，frontmatter 标记 `transcript: false` 方便 Obsidian 过滤。
- 简介中的讲义 PDF、课程主页等外部链接自动提取为「配套资料」章节。
- 按博主名称自动建文件夹，同名文件自动加序号后缀，不会互相覆盖。
- Web 界面实时显示进度（SSE），关掉页面会自动中止后台任务。

## 安装

1. Node.js v18+。
2. `npm install`
3. 安装系统级 `yt-dlp`（强烈建议，程序会优先使用）：`brew install yt-dlp`。
   - 未安装时回退到项目内置二进制，但内置版本会随时间过期，可运行 `npm run update-ytdlp` 自更新。
4. 复制 `.env.example` 为 `.env`，填入 AI Key（`cp .env.example .env`）。

## 环境变量（.env）

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `AI_API_KEY` | AI 总结服务 Key（OpenAI 兼容接口） | `sk-...` |
| `AI_API_BASE` | AI 总结服务地址 | `https://api.deepseek.com/v1` |
| `AI_MODEL` | 总结用模型名 | `deepseek-chat` |
| `ASR_API_KEY` | 语音转写 Key（可选，无字幕时自动转写） | `...` |
| `ASR_API_BASE` | 转写服务地址（OpenAI 兼容 `/audio/transcriptions`） | `https://open.bigmodel.cn/api/paas/v4` |
| `ASR_MODEL` | 转写模型 | `glm-asr` / `whisper-1` |
| `OUTPUT_DIR` | 输出目录（默认 Obsidian 路径） | `/path/to/dir` |
| `SUB_LANGS` | 字幕语言匹配式 | `zh.*,ai_.*,en.*` |
| `PORT` | Web 服务端口 | `3000` |

> 字幕抓取依赖 `--cookies-from-browser chrome` 读取本机 Chrome 的 Cookie，请确保 Chrome 已登录常用状态；未装 Chrome 会自动降级为无 Cookie 模式。

## 笔记内容链路

```
有字幕轨 ──────────────→ 文稿入库（transcript: "subtitles"）→ AI 总结
无字幕 + 已配 ASR ────→ 下载音频转写（transcript: "asr"）────→ AI 总结
无字幕 + 未配 ASR ────→ 来源卡片（transcript: false）───────→ 不调用 AI，仅收录简介与配套资料
```

在 Obsidian 中可用搜索 `transcript: false` 找到「尚未真正消化」的笔记，配好 ASR 后对同链接重跑即可补全。

## 使用

### Web 界面

```bash
npm start
# 打开 http://localhost:3000
```

### 命令行

```bash
# 博主主页（限制数量）
node index.js "https://www.youtube.com/@Google/videos" -l 5

# 单个视频
node index.js "https://www.youtube.com/watch?v=xxxx"

# 指定输出目录
node index.js "https://www.bilibili.com/video/BVxxxx" -o ~/Downloads/tubes
```

选项：`-l/--limit` 数量上限；`-k/--key`、`-b/--base`、`-m/--model` AI 配置（默认读 .env）；`-o/--out` 输出目录。

## 已知限制

- YouTube 对字幕下载有 PO Token 风控：默认客户端取不到时，程序会自动回退 `web_embedded` / `tv_embedded` 客户端；仍取不到时走 ASR 或来源卡片链路。
- ASR 依赖外部转写 API（25MB 限制，超限自动用 ffmpeg 压缩），未配置时无字幕视频只产出来源卡片。
- 抖音 / TikTok 未做专门适配，取决于 yt-dlp 对其的当前支持度。
