// 服务自身的维护：安全重启、定期清理。

import { copyFileSync, existsSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, INBOX_DIR, RESTART_MARKER, ROOT_DIR, SUPERVISED } from "./config.js";
import { run } from "./host.js";
import { runningCount } from "./jobs.js";
import { logError } from "./log.js";

/** 重启前先做一遍类型检查。返回 undefined 表示通过，否则返回错误摘要。 */
export async function checkCode(): Promise<string | undefined> {
  // 作为编译好的程序安装时没有编译器，也没有源码可查，直接放行
  if (!existsSync(join(ROOT_DIR, "node_modules/typescript/bin/tsc")) || !existsSync(join(ROOT_DIR, "tsconfig.json"))) {
    return undefined;
  }
  try {
    await run(process.execPath, [join(ROOT_DIR, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", ROOT_DIR], {
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return undefined;
  } catch (err) {
    const out = String((err as { stdout?: unknown }).stdout ?? "") || String(err);
    return out.split("\n").filter(Boolean).slice(0, 8).join("\n").slice(0, 1500);
  }
}

export async function restart(chatId: string, force: boolean): Promise<string> {
  if (!SUPERVISED) {
    return "bridge 现在是在终端里手动启动的，没法自己重启。请在终端按 Ctrl+C 后重新启动，或者运行 chat-agent-bridge service install 改成后台服务。";
  }
  const busy = runningCount();
  if (busy > 0 && !force) {
    return `还有 ${busy} 个任务在执行，重启会中断它们。确定的话发 /restart force。`;
  }
  // 代码有错误时重启会让服务反复崩溃、群里再也叫不动它，所以先检查
  const problem = await checkCode();
  if (problem) {
    return `代码检查没通过，没有重启。先修好这些错误：\n\`\`\`\n${problem}\n\`\`\``;
  }
  writeFileSync(RESTART_MARKER, chatId);
  setTimeout(() => process.exit(0), 800);
  return "代码检查通过，正在重启，几秒后回来。";
}

export const INBOX_KEEP_MS = 7 * 24 * 3600_000;

export const LOG_FILE = join(DATA_DIR, "logs", "bridge.log");

export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 删掉 7 天前收到的图片和文件；日志超过 5 MB 时留一份备份后清空。 */
export function housekeeping(): void {
  try {
    for (const name of existsSync(INBOX_DIR) ? readdirSync(INBOX_DIR) : []) {
      const path = join(INBOX_DIR, name);
      if (Date.now() - statSync(path).mtimeMs > INBOX_KEEP_MS) rmSync(path, { recursive: true, force: true });
    }
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      copyFileSync(LOG_FILE, `${LOG_FILE}.1`);
      truncateSync(LOG_FILE, 0);
    }
  } catch (err) {
    logError("清理出错", err);
  }
}
