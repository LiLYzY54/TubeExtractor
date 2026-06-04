# TubeExtractor

一个自动提取博主主页所有视频内容并存入 Obsidian 的工具。

## 功能
*   支持 YouTube, Bilibili, 抖音, TikTok 等多个平台。
*   自动提取视频标题、简介、描述以及文稿（Transcript）。
*   按博主名称自动分类创建文件夹。
*   输出纯净的 Markdown 格式，完美集成到 Obsidian。

## 安装
1.  确保已安装 Node.js (v18+)。
2.  进入项目目录: `cd ~/TubeExtractor`
3.  安装依赖: `npm install`
4.  (推荐) 安装 `yt-dlp`: `brew install yt-dlp` (虽然内置了二进制，但系统级安装更稳定)。

## 使用方法
在终端中运行：
```bash
node index.js "博主主页URL"
```

### 常用选项
*   `--limit <n>`: 限制处理的视频数量（例如只处理最新的 5 个视频）。
    ```bash
    node index.js "https://www.youtube.com/@Google/videos" --limit 5
    ```

## Obsidian 存放路径
目前默认存放于：
`/Users/lilyzy/Documents/Obsidian/Daily_Thoughts/Inbox/Tubes/`
