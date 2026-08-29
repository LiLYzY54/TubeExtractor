# TubeExtractor 修复清单 · 第四轮（预检 + 合集选择 + 增量同步）

> 需求：粘贴博主主页后**不要立即全量解析**，先做秒级预检，把合集/视频列表交给用户勾选，确认后才执行。单视频链接不进选择页、直接执行（用户已确认）。
> 已验证技术前提：YouTube `@handle/playlists` flat 扫描可枚举合集；B 站 `seasons_series_list` API 免登录返回合集（名称/视频数/season_id）。
> 动画规范：按 `~/.agents/skills/animate`（emilkowalski）执行——只动 transform/opacity，入场 ease-out `cubic-bezier(0.23,1,0.32,1)`，150–300ms，列表 30–80ms stagger，禁止 ease-in/scale(0)/transition:all，必带 prefers-reduced-motion。

## P1. 预检层（后端）

- [x] **P1.1 `scanSyncedUrls(baseDir)`**：遍历输出目录所有 md 的 frontmatter `source:` 行，返回已入库 URL 集合（增量同步基础）。
- [x] **P1.2 `previewTarget(url)`**：URL 分类与廉价枚举
  - 单视频（含 B 站单 BV）→ flat 扫一次：多 P（entries>1）→ `videos` 模式让用户挑；否则 `single` 直通。
  - YouTube 频道 → 归一化后扫 `/playlists`（合集，上限 30）+ `/videos`（最近视频，上限 60）。
  - B 站空间（`space.bilibili.com/{mid}`）→ seasons/series API 取合集 + yt-dlp flat 取最近视频（上限 60）。
  - YouTube 单合集（`/playlist?list=`）→ 展开该合集视频列表。
  - 其他平台 → flat 扫描，entries>1 视为 `videos`，否则 `single`。
  - 返回统一结构 `{ mode: 'single'|'videos'|'collections', creator, platform, collections[], videos[] }`；每个视频带 `synced` 标记。
  - 内存缓存 5 分钟（同 URL 不重复扫描）。
- [x] **P1.3 选择展开 `expandSelection(selection)`**：
  - `yt-playlist` → yt-dlp flat 展开视频列表。
  - `bili-season` / `bili-series` → 官方 API 分页拉取 bvid 列表（带 Referer）。
  - 与 `selection.videos`（手动勾选的 URL）合并去重为执行清单。

## P2. 执行层接入选择

- [x] **P2.1** `extractToObsidian` 接受 `selection` + `skipSynced`：有 selection 时以展开清单为准（不再用主页 flat entries）；`skipSynced=true` 时跳过已入库视频并在进度里说明。
- [x] **P2.2** `server.js` 新增 `POST /api/preview`（JSON，错误 JSON 化）；`/api/extract` 透传 `selection`/`skipSynced`。单视频且无 selection 时行为不变。

## P3. 选择界面（前端，动画按 animate 技能）

- [x] **P3.1** 提交链接 → 先 POST `/api/preview`：
  - `single` → 直接走现有 extract 流（不进选择页，符合用户确认的规则）。
  - `videos`/`collections` → 渲染选择界面。
- [x] **P3.2** 界面内容：合集多选卡片（视频数徽标）+「手动挑选」视频勾选列表（已同步的标注"已同步"）+「跳过已同步」开关（默认开）+ 全选/清空 + 确认按钮（实时显示"已选 N 个视频"，0 个时禁用）。
- [x] **P3.3** 动画（按技能规范做出决策）：
  - 频率档：偶尔使用（每次任务一次）→ 标准动画；目的：防止生硬跳变（preview→selection 的内容桥接）。
  - 区块入场：opacity + translateY(12px)，200ms `cubic-bezier(0.23,1,0.32,1)`；卡片列表 40ms stagger。
  - 勾选反馈：勾标 scale(0.9→1)+opacity 150ms ease-out（transition 非 keyframe，可快速连点）。
  - hover：translateY(-2px)+边框色，150ms `ease`，`@media (hover:hover) and (pointer:fine)` 门控。
  - `prefers-reduced-motion: reduce` → 全部降级为 150ms 纯 opacity。
- [x] **P3.4** 选择页可返回重填链接；确认后进入现有 SSE 进度视图。

## P4. CLI 同步

- [x] `--list`：打印 preview 结果（合集/视频清单）；`--collection <名称子串>`：选中名称匹配的合集执行；不传时保持现状（全量 + limit）。

## 验证计划（全部通过才能结束）

1. 后端 preview：YouTube 频道（含合集枚举）、B 站空间（合集 API）、单视频（single 判定）、B 站多 P（videos 判定）。
2. 增量标记：对已有笔记的博主 preview，synced 标记正确。
3. selection 展开：yt-playlist / bili-season 各展开 ≥1 个合集并成功执行入库。
4. 浏览器 e2e：粘贴频道链接 → 选择页出现（动画无障碍属性到位）→ 勾选合集 → 执行 → 笔记落盘；粘贴单视频 → 不出现选择页直接执行。
5. skipSynced：第二次执行同合集，已同步视频被跳过。
