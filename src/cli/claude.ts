// 检查这台电脑上的 Claude Code 是否已登录，以及帮用户登录。

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ClaudeAccount {
  loggedIn: boolean;
  /** 订阅类型，如 pro、max；用 API key 时为空 */
  subscription?: string;
  error?: string;
}

/** 查询登录状态。只启动 Claude Code 进程问一下账号信息，不发送任何提示词。 */
export async function claudeAccount(apiKey?: string): Promise<ClaudeAccount> {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await hold;
  }
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  const q = query({ prompt: idle(), options: { cwd: homedir(), settingSources: [], env } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const info = await Promise.race([
      q.accountInfo(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("查询超时")), 30_000);
      }),
    ]);
    const loggedIn = Boolean(info.subscriptionType || info.tokenSource || info.apiKeySource || info.email);
    return { loggedIn, subscription: info.subscriptionType };
  } catch (err) {
    return { loggedIn: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    release();
    await q.return(undefined).catch(() => {});
  }
}

/** Agent SDK 自带的 Claude Code 程序；找不到时退回到 PATH 里的 claude。 */
export function claudeBinary(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const binary = join(dirname(pkg), "claude");
    if (existsSync(binary)) return binary;
  } catch {
    // 没有对应平台的包
  }
  return "claude";
}

/** 在当前终端里运行 Claude Code 的登录流程（会打开浏览器）。返回是否正常结束。 */
export function runClaudeLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(claudeBinary(), ["auth", "login"], { stdio: "inherit" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}
