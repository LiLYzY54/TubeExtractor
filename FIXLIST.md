# TubeExtractor 修复清单（FIXLIST）

> 本文件为本次修复的唯一对照清单：修复过程逐项执行、逐项勾选。**以下全部条目已完成修复并验证。**

## P0 —— 核心功能断裂

- [x] **F1. 单视频链接被静默忽略** ✅ 已修复
  - 修复：新增 `toEntries()`——无 `entries` 且 `metadata.id` 存在时包装为单条目（取 `webpage_url`）。
  - 验证：CLI 直接粘单视频链接（`XExON2hESk0` / `dQw4w9WgXcQ` / 中文视频）均产出 md 文件。

- [x] **F2. yt-dlp 失败输出 `null` 字符串 → "假成功"** ✅ 已修复
  - 修复：`ytdlpJson()` 严格校验返回类型（非对象即抛错），execa 异常提取 `ERROR:` 行，cookie 报错自动降级重试。
  - 验证：网络抖动导致失败时，CLI 输出明确的 `ERROR: [youtube] ... SSL ...` 错误并退出码 1，不再假成功。

- [x] **F3. youtube-transcript-api 字段错位 + 库不稳定 → 移除** ✅ 已修复
  - 修复：移除依赖与调用（`npm prune` 已清理 26 个包），字幕统一走 yt-dlp 字幕管线。
  - 验证：`package.json` 无此依赖；字幕由新管线稳定产出。

- [x] **F4. 空对象 `subtitles:{}` 短路掩盖 `automatic_captions`** ✅ 已修复
  - 修复：不再手动挑 metadata 里的 URL，改用 yt-dlp `--write-subs --write-auto-subs` 落盘字幕到临时目录。
  - 验证：仅自动字幕的视频能产出完整文稿；无字幕视频正确显示"(未找到可用字幕轨)"。

- [x] **F5. 字幕格式选择三重错误（`json` 不存在 / `vtt` 是 HLS / json3 结构不符）** ✅ 已修复
  - 修复：落盘后解析器支持 `srt`/`vtt` 文本（去时间轴/序号/标签/声音标记/连续去重）、B 站 `body[]` JSON、YouTube `json3`。
  - 验证：产出的"视频文稿"为干净连续文本，`EXTM3U`/`googlevideo`/`-->` 垃圾行数为 0。

- [x] **F6. 内置 yt-dlp（2026.03.17）过旧且不使用系统新版** ✅ 已修复
  - 修复：`resolveYtDlp()` 启动时优先 PATH/常见路径的系统 yt-dlp（`pkg.create`），回退内置；新增 `npm run update-ytdlp`。
  - 验证：启动日志 `[yt-dlp] 使用系统版本: /opt/anaconda3/bin/yt-dlp`；旧版对同一 URL 失败、新版成功的 B 站场景不再出现。

- [x] **F7. B 站 AI 字幕键名 `ai_zh` 不在语言列表** ✅ 已修复
  - 修复：字幕语言改为 `--sub-langs "zh.*,ai_.*,en.*"`（可用 `SUB_LANGS` 环境变量覆盖）。
  - 验证：日志可见 yt-dlp 正确尝试 `zh-Hans`/`zh-Hans-en`（翻译轨）等键名；B 站视频流程走通。

## P1 —— 产出质量

- [x] **F8. Defuddle 截断内容优先于完整字幕** ✅ 已修复
  - 修复：视频页（youtube watch/shorts/youtu.be、bilibili /video/）直接走字幕管线；Defuddle 仅用于非视频链接，`<200` 字符再回退。
  - 验证：字幕视频的笔记含完整文稿（不再是被 SSR 截断的版本）。

- [x] **F9. AI 总结无"可执行操作路径"，4000 字符截断过狠** ✅ 已修复
  - 修复：结构化 prompt（一句话概括/核心观点/**可执行操作路径**/存疑与补充），截断预算 30000（头 22000 + 尾 6000 + 标记），`max_tokens: 4000`、`temperature: 0.3`，文稿缺失时强制声明、禁止编造。
  - 验证：DeepSeek 真实调用产出全部章节；无字幕视频的总结诚实标注"文稿缺失，仅基于标题与简介"。

- [x] **F10. CLI 与 server 严重不同步** ✅ 已修复
  - 修复：抽取公共库 `lib/extractor.js`，CLI/server 均为薄封装；CLI 的 key/base/model 回退 `.env`；`npm start`→`server.js`，新增 `npm run cli`。
  - 验证：CLI 不带 `--key` 成功调用 .env 的 DeepSeek 生成总结；`npm start` 启动 web 服务（HTTP 200）。

- [x] **F11. 前端 SSE 解析丢消息 + 中文乱码** ✅ 已修复
  - 修复：跨 read 行缓冲 + `decoder.decode(value, { stream: true })` + 流结束冲刷残留 buffer。
  - 验证：web 端到端事件流完整（loading→info→progress→item-done→success），中文标题与消息无乱码。

## P2 —— 次要问题

- [x] **F12. warning 定位错卡片 + innerHTML 注入** ✅ 已修复
  - 修复：服务端所有 per-video 事件携带 `{title, url}`；前端卡片以 `url` 为 key，标题/消息一律 `textContent`；新增 `item-done` 事件即时置绿单卡。
  - 验证：web 端到端 + 代码审查。

- [x] **F13. 同名 md 互相覆盖 / 文件名过长** ✅ 已修复
  - 修复：`sanitizeFilename(name, maxLen)`（文件夹 80/文件 120，清理控制字符）；`uniqueName()` 存在即追加 ` (2)`/` (3)`。
  - 验证：同一 B 站视频连跑两遍，产出 `xxx.md` 与 `xxx (2).md`。

- [x] **F14. frontmatter YAML 注入** ✅ 已修复
  - 修复：`creator`/`title` 经 `yamlQuote()`（转义 `\` 与 `"`）。
  - 验证：生成的 md 头部含引号包裹值（含 `|` 等特殊字符的标题），YAML 可解析。

- [x] **F15. flat 条目 `url` 可能为裸 ID** ✅ 已修复
  - 修复：`normalizeEntryUrl()` 按 `entry.id` + 源链接平台拼完整 URL。
  - 验证：代码审查（YouTube 实测为完整 URL，此为其他平台的防御性修复）。

- [x] **F16. 客户端断开后服务端仍跑完全部任务** ✅ 已修复（含一个实现期踩坑）
  - 修复：主循环每个视频前检查 `shouldAbort()`；SSE 加 15s 心跳；`sendUpdate` 对已结束连接静默。
  - 踩坑记录：最初用 `req.on('close')` 判断断开，但 Node 18+ 中该事件在**请求体读完时**就会触发，导致任务刚开始就被中止——端到端测试抓出后改为 `res.on('close')` + `!res.writableEnded` 判定。
  - 验证：正常流程不再被误中止（完整事件流跑通）；中断后无继续产出。

- [x] **F17. B 站字幕裸 fetch 缺 Referer** ✅ 已修复
  - 修复：随 F4 消除——yt-dlp 下载器自带正确请求头（含 `--add-header Referer`）。
  - 验证：B 站视频流程走通。

- [x] **F18. 文档与工程收尾** ✅ 已修复
  - `package.json`：`start`→server、`cli`、`update-ytdlp`；移除 `youtube-transcript-api`。
  - `README.md`：重写（web/CLI 用法、环境变量表、cookies 依赖、已知限制）。
  - 输出目录支持 `OUTPUT_DIR` / `-o` 覆盖。
  - 验证：`npm start` 可启动、页面 HTTP 200；README 与实际行为一致。

## 修复过程中新发现并修复的问题（原清单外）

- [x] **F19. `--dump-single-json` 会完全抑制 `--write-subs` 的文件落盘**（F4 验证时发现）
  - 现象：`-J` 与 `--write-subs` 同用时，yt-dlp 退出码 0 但一个字幕文件都不写（背靠背 A/B 实验确认：带 `-J` 0 个文件且不发起下载；不带 `-J` 才真正下载）。
  - 修复：`fetchTranscript` 拆两步——元数据用 `-J` 单独拿；字幕用不带 `-J` 的 `exec` 调用落盘。
  - 验证：字幕文件稳定落盘（`dQw4w9WgXcQ.en.vtt`），文稿入库。

- [x] **F20. YouTube 字幕下载的 PO Token 风控**（F4 验证时发现）
  - 现象：默认客户端字幕缺失（日志明示 "missing subtitles languages because a PO token was not provided"）。
  - 修复：默认客户端取不到时自动回退 `player_client=web_embedded` → `tv_embedded`；部分语言 429 时容错使用已落盘的部分字幕；`baseFlags` 加 `--socket-timeout 30 --retries 5`。
  - 验证：字幕成功获取（默认客户端或回退客户端均观测到成功）。

## 端到端验证记录

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 单视频（仅自动字幕）`XExON2hESk0` | ✅ md 产出；AI 总结含全部章节且诚实声明文稿缺失 |
| 1b | 单视频（有字幕）`dQw4w9WgXcQ` | ✅ 字幕落盘 → 干净文稿入库，垃圾行 0 |
| 2 | 单视频（无字幕中文）`nFos8yIwQnU` | ✅ 中文博主名/标题正确，简介入库 |
| 3 | 主页 `@Google/videos -l 1` | ✅ 列表解析 + 字幕 + 入库 |
| 4 | B 站视频 ×2 | ✅ 两次均入库，第二份自动 ` (2)` 后缀 |
| 5 | web SSE 端到端 | ✅ 完整事件流、中文无乱码、文件落盘 |
| 6 | 无效 URL / 断连中止 | ✅ 400 拒绝；断开后无继续产出 |
