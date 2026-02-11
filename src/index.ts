import * as dotenv from "dotenv";
dotenv.config();

import { program } from "commander";
import { startTelegram } from "./app";

program
  .option("--url <url>", "OpenCode server URL", "http://localhost:4096")
  .option("--model <model>", "Model to use (e.g. anthropic/claude-sonnet-4-20250514)")
  .parse(process.argv);

const options = program.opts();

async function main() {
  await startTelegram({
    url: options.url,
    model: options.model,
  });
}

main().catch((err) => {
  console.error("Error starting Telegram bot:", err);
});
