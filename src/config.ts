// 环境变量里的配置，以及几个固定路径。不依赖其他模块。

import * as lark from "@larksuiteoapi/node-sdk";
import { type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`缺少配置 ${name}。请先运行 chat-agent-bridge init。`);
    process.exit(1);
  }
  return v;
}

export function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const APP_ID = required("LARK_APP_ID");

export const APP_SECRET = required("LARK_APP_SECRET");

export const DOMAIN =
  process.env.LARK_DOMAIN?.trim() === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

export const OWNER_OPEN_ID = process.env.OWNER_OPEN_ID?.trim() ?? "";

export const ALLOWED_CHAT_IDS = new Set(list("ALLOWED_CHAT_IDS"));

export const CLAUDE_CWD = process.env.CLAUDE_CWD?.trim() || process.cwd();

export const ALLOWED_TOOLS = list("ALLOWED_TOOLS");

export const BASH_ALLOWED = ALLOWED_TOOLS.includes("Bash");

export const PERMISSION_MODE = (process.env.PERMISSION_MODE?.trim() || "default") as PermissionMode;

// 认证方式：
// - subscription（默认）：用本机 Claude Code 的订阅登录。订阅只限账号持有人本人使用，
//   所以这个模式下只有主人能指挥，白名单里的其他人不会被执行。
// - api_key：用 Console 的 API key。这个模式下白名单里的人才生效。
export const AUTH_MODE: "subscription" | "api_key" =
  process.env.AUTH_MODE?.trim() === "api_key" ? "api_key" : "subscription";

if (AUTH_MODE === "api_key" && !process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error("API key 模式需要填写 API key。请重新运行 chat-agent-bridge init。");
  process.exit(1);
}

export const claudeEnv: Record<string, string | undefined> = { ...process.env };

if (AUTH_MODE === "subscription") {
  // 强制走订阅登录：不把 API key 传给 Claude 进程
  delete claudeEnv.ANTHROPIC_API_KEY;
  delete claudeEnv.ANTHROPIC_AUTH_TOKEN;
}

export const SUPERVISED = process.env.BRIDGE_SUPERVISED === "1";

export const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));

/** 保存设置、会话、白名单、定时任务、收到的文件和日志的目录。测试时指到临时目录，免得动到真实数据。 */
export const DATA_DIR = process.env.BRIDGE_DATA_DIR?.trim() || join(homedir(), ".chat-agent-bridge");

export function dataFile(name: string): string {
  return join(DATA_DIR, name);
}

export const INBOX_DIR = dataFile("inbox");

export const RESTART_MARKER = dataFile(".restart-notify");
