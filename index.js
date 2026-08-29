import { program } from 'commander';
import 'dotenv/config';
import { extractToObsidian, previewTarget, expandSelection } from './lib/extractor.js';

program
  .name('tube-extractor')
  .description('从单个视频或博主主页链接提取内容，生成 Markdown 存入 Obsidian')
  .argument('<url>', '视频链接或博主主页链接')
  .option('-l, --limit <number>', '限制处理的视频数量', parseInt)
  .option('-k, --key <string>', 'AI API Key（默认读取 .env 中的 AI_API_KEY）')
  .option('-b, --base <string>', 'AI Base URL（默认读取 .env 中的 AI_API_BASE）')
  .option('-m, --model <string>', 'AI 模型名（默认读取 .env 中的 AI_MODEL）')
  .option('-o, --out <dir>', '输出目录（默认读取 OUTPUT_DIR 环境变量，或 Obsidian 路径）')
  .option('--list', '仅预检并列出合集/视频清单，不执行提取')
  .option('--collection <substr>', '只提取名称包含该子串的合集（配合主页链接使用）')
  .option('--no-skip-synced', '不跳过已同步的视频（默认 --collection 模式自动跳过）')
  .action(async (url, options) => {
    try {
      if (options.list) {
        const preview = await previewTarget(url);
        console.log(`博主: ${preview.creator}（${preview.platform}，已同步 ${preview.syncTotal} 篇）`);
        if (preview.collections.length) {
          console.log(`\n合集（${preview.collections.length}）: 使用 --collection "<名称子串>" 选择其一`);
          for (const c of preview.collections) {
            console.log(`  - ${c.title}${c.count != null ? `（${c.count} 个视频）` : ''}`);
          }
        }
        if (preview.videos.length) {
          console.log(`\n最近视频（${preview.videos.length}）:`);
          for (const v of preview.videos) {
            console.log(`  - ${v.synced ? '[已同步] ' : ''}${v.title || v.url}`);
          }
        }
        return;
      }

      let selection;
      let creator;
      let skipSynced;
      if (options.collection) {
        const preview = await previewTarget(url);
        const matched = preview.collections.filter((c) => c.title.includes(options.collection));
        if (!matched.length) {
          console.error(`[❌] 未找到名称包含"${options.collection}"的合集。可用合集：`);
          for (const c of preview.collections) console.error(`  - ${c.title}`);
          process.exitCode = 1;
          return;
        }
        console.log(`[+] 选中 ${matched.length} 个合集: ${matched.map((c) => c.title).join('、')}`);
        selection = { collections: matched, videos: [] };
        creator = preview.creator;
        skipSynced = options.skipSynced !== false;
      }

      const result = await extractToObsidian({
        url,
        limit: options.limit,
        selection,
        skipSynced,
        creator,
        apiKey: options.key || process.env.AI_API_KEY,
        apiBase: options.base || process.env.AI_API_BASE,
        model: options.model || process.env.AI_MODEL,
        outputDir: options.out,
        onUpdate: (status, message) => {
          if (status === 'warning') console.error(`[!] ${message}`);
          else if (status === 'item-done') console.log(`    ✔ ${message}`);
          else if (status === 'progress-detail') console.log(`    ${message}`);
          else console.log(`[+] ${message}`);
        },
      });
      console.log(`[✔] 任务完成！成功 ${result.ok}/${result.total}，失败 ${result.fail}。`);
    } catch (error) {
      console.error(`[❌] 错误: ${error.message}`);
      process.exitCode = 1;
    }
  });

program.parse();
