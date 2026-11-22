// 命令行工具的配置：保存在数据目录的 config.json 里，启动 bridge 前转成环境变量。

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface BridgeConfig {
  appId: string;
  appSecret: string;
  /** lark = 国际版，feishu = 国内版 */
  domain: "lark" | "feishu";
  ownerOpenId: string;
  allowedChatIds: string[];
  allowedTools: string[];
  authMode: "subscription" | "api_key";
  apiKey?: string;
}

/** 权限档位对应的工具列表 */
export const TOOL_LEVELS = {
  readonly: ["Read", "Glob", "Grep"],
  edit: ["Read", "Glob", "Grep", "Edit", "Write"],
  full: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
} as const;

/** 数据目录：默认 ~/.chat-agent-bridge，可以用 BRIDGE_DATA_DIR 改到别处。 */
export function dataDir(): string {
  return process.env.BRIDGE_DATA_DIR?.trim() || join(homedir(), ".chat-agent-bridge");
}

export function configPath(): string {
  return join(dataDir(), "config.json");
}

export function loadConfig(): BridgeConfig | undefined {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<BridgeConfig>;
    if (!raw.appId || !raw.appSecret) return undefined;
    return {
      appId: raw.appId,
      appSecret: raw.appSecret,
      domain: raw.domain === "feishu" ? "feishu" : "lark",
      ownerOpenId: raw.ownerOpenId ?? "",
      allowedChatIds: Array.isArray(raw.allowedChatIds) ? raw.allowedChatIds : [],
      allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools : [...TOOL_LEVELS.readonly],
      authMode: raw.authMode === "api_key" ? "api_key" : "subscription",
      ...(raw.apiKey ? { apiKey: raw.apiKey } : {}),
    };
  } catch {
    return undefined;
  }
}

/** 配置里有应用密钥，文件只允许本人读写。 */
export function saveConfig(config: BridgeConfig): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(configPath(), 0o600);
}

/** 项目列表，路径里的 ~ 已展开成完整路径。 */
export function loadProjects(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir(), "projects.json"), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(raw)
        .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "")
        .map(([name, dir]) => [name, resolve(dir.startsWith("~") ? homedir() + dir.slice(1) : dir)]),
    );
  } catch {
    return {};
  }
}

export function saveProjects(projects: Record<string, string>): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(join(dataDir(), "projects.json"), JSON.stringify(projects, null, 2));
}

/** 把配置写进环境变量。必须在导入 bridge 的其他模块之前调用。 */
export function applyEnv(config: BridgeConfig): void {
  const firstProject = Object.values(loadProjects())[0];
  Object.assign(process.env, {
    BRIDGE_DATA_DIR: dataDir(),
    LARK_APP_ID: config.appId,
    LARK_APP_SECRET: config.appSecret,
    LARK_DOMAIN: config.domain,
    OWNER_OPEN_ID: config.ownerOpenId,
    ALLOWED_CHAT_IDS: config.allowedChatIds.join(","),
    ALLOWED_TOOLS: config.allowedTools.join(","),
    AUTH_MODE: config.authMode,
    CLAUDE_CWD: firstProject && existsSync(firstProject) ? firstProject : homedir(),
  });
  if (config.authMode === "api_key" && config.apiKey) process.env.ANTHROPIC_API_KEY = config.apiKey;
}

/** 读取旧式 .env 文件里的键值，用于从手动配置的安装迁移过来。 */
export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
