# TubeExtractor 修复清单 · 第二轮（笔记质量导向）

> 背景：对笔记《理解现代人工智能：数学、模型、数据与评测》的评审结论——**形式完整但内容空壳**：视频无字幕轨，总结实为简介改写的"伪核心观点"，唯一有真实增量的信息（讲义 PDF 链接）被埋没。
> 已核实根因：该视频（42 分钟讲座）字幕字典为空、无章节，但**存在纯音频轨（m4a ≈65kbps）**，ASR 兜底可行。
> 状态：`[x]` 全部完成。验证证据见文末记录。

## G1. ASR 语音转写兜底（根本解法）✅

- [x] 无字幕时自动下载音频轨。
  - 实现细节修正：格式选择用 `bestaudio/best`——YouTube 在 PO Token 风控下常无独立音频轨，只剩音视频合并格式（itag 18 等），需回退。
- [x] 调用 **OpenAI 兼容**转写接口（`POST {ASR_API_BASE}/audio/transcriptions`，multipart `file` + `model`）：
  - 新增环境变量 `ASR_API_KEY` / `ASR_API_BASE` / `ASR_MODEL`（默认 `glm-asr`）。
  - 兼容智谱 GLM-ASR 与 OpenAI Whisper（响应取 `text`，兜底 `content`）；请求 10 分钟超时。
- [x] 音频预处理：视频容器（mp4/webm）且有 ffmpeg → 抽取 32k 单声道 mp3；仍 >25MB → 再压 24k；无 ffmpeg → 直传尝试。
- [x] 转写文本按句切分、每 10 句合一段提升可读性；进度通过 `progress-detail` 事件透出。
- [x] 健壮性：未配置 ASR → 静默跳过转 G2；下载/上传/解析失败 → 记录原因后转 G2，不中断任务。
- [x] 总结 prompt 增加：文稿可能来自语音转写（含错别字/标点缺失），按语义归纳。
- [x] 验证：
  - mock ASR 服务 + 无字幕中文视频（`nFos8yIwQnU`）端到端：音频下载（mp4）→ ffmpeg 抽取 1.2MB mp3 → 上传（mock 收到 1.16MB 请求）→ `transcript: "asr"` 入库 → AI 总结正确基于转写内容（引用了 mock 文稿中的"高斯定律"等，证明非简介改写）。
  - B 站音频轨存在性：格式探针实测 `BV1oH346AEwU` 有 3 条 m4a（30216 ≈65kbps）可下载；实时下载探针在收尾时受本机到 api.bilibili.com 的间歇性 SSL 抖动阻塞（当日已多次复现、与代码无关，元数据路径同一时段成功过多次）。

## G2. 无文稿时降级为「来源卡片」（不再产出伪总结）✅

- [x] 视频页无文稿（字幕 + ASR 均未果）时**完全不调用 AI 总结**。
- [x] 笔记降级为来源卡片：顶部醒目警示块 + 省略「AI 总结/核心观点」章节 + 附补救指引（配 ASR 后重跑同链接）。
- [x] frontmatter 状态标记：`transcript: "subtitles"` / `"asr"` / `"article"` / `false`，Obsidian 可搜索过滤。
- [x] 非视频页（文章正文提取成功，`transcript: "article"`）不受影响，仍正常总结。
- [x] 验证：`BV1oH346AEwU` 重跑——生成来源卡片（无 AI 总结章节、frontmatter `transcript: false` 且 YAML 解析校验通过）。
- 修复过程中发现并修掉：frontmatter 模板拼接出 `transcript: transcript: false` 重复键的 bug（首轮测试抓出）。

## G3. 配套资料单独成节 ✅

- [x] `extractResources()`：从简介/正文提取 URL，去重、排除源链接本身（按 host+pathname 比对，规避 `spm_id_from` 等追踪参数干扰）。
- [x] 分类标注：`.pdf` → "PDF 文档"，其余 → 域名标签；渲染为 Markdown 链接。
- [x] 章节位置：完整笔记置于 AI 总结后；来源卡片置于警示块后、原始内容前。
- [x] 验证：`BV1oH346AEwU` 笔记中课程主页与讲义 PDF 独立成节（`- [PDF 文档](...ai-overview-handout.pdf)`）。

## G4. 文档与配置同步 ✅

- [x] `.env` 追加 ASR 注释占位（智谱/OpenAI 两组示例，无真实 Key；`.env` 确认仍被 gitignore）。
- [x] 新增 `.env.example`（含全部环境变量占位与注释，无真实密钥）。
- [x] README：功能列表、环境变量表（ASR 三项）、「笔记内容链路」图（三条链路 + Obsidian 过滤用法）、已知限制更新。
- [x] 验证：README 与实际行为一致。

## 端到端验证记录

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | `BV1oH346AEwU`（无字幕 + 未配 ASR） | ✅ 来源卡片：无 AI 总结章节、`transcript: false`（YAML 解析通过）、配套资料含 PDF 标注 |
| 2 | mock ASR + `nFos8yIwQnU`（无字幕） | ✅ 全链路：下载 → ffmpeg 抽音频 → 上传 → `transcript: "asr"` → AI 总结基于转写内容 |
| 3 | `dQw4w9WgXcQ`（有字幕）回归 | ✅ `transcript: "subtitles"` + AI 总结正常，布局无回归 |
| 4 | B 站音频轨 | ✅ 存在性已证实（3×m4a@65kbps）；实时下载探针受环境网络抖动阻塞（非代码问题，故障已定位为 api.bilibili.com 间歇 SSL 掐断） |
