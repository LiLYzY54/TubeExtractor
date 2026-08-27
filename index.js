import { program } from 'commander';
import 'dotenv/config';
import { extractToObsidian } from './lib/extractor.js';

program
  .name('tube-extractor')
  .description('从单个视频或博主主页链接提取内容，生成 Markdown 存入 Obsidian')
  .argument('<url>', '视频链接或博主主页链接')
  .option('-l, --limit <number>', '限制处理的视频数量', parseInt)
  .option('-k, --key <string>', 'AI API Key（默认读取 .env 中的 AI_API_KEY）')
  .option('-b, --base <string>', 'AI Base URL（默认读取 .env 中的 AI_API_BASE）')
  .option('-m, --model <string>', 'AI 模型名（默认读取 .env 中的 AI_MODEL）')
  .option('-o, --out <dir>', '输出目录（默认读取 OUTPUT_DIR 环境变量，或 Obsidian 路径）')
  .action(async (url, options) => {
    try {
      const result = await extractToObsidian({
        url,
        limit: options.limit,
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
