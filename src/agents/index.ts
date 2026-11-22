// 已接入的 agent。要加一个新的：在这个目录里实现 Agent 接口，然后加进下面的列表。

import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { type Agent } from "./types.js";

export type { Agent, AgentFeatures, AgentHooks, AgentTask } from "./types.js";

/** 写成函数而不是常量：各模块之间有循环引用，等到真正用的时候再取才稳妥。 */
export function allAgents(): Agent[] {
  return [claude, codex];
}

export const DEFAULT_AGENT = "claude";

export function isAgentId(id: string): boolean {
  return allAgents().some((a) => a.id === id);
}

/** 按标识找 agent；不认识的标识（比如配置里留下的旧值）退回到默认的。 */
export function agentOf(id: string | undefined): Agent {
  return allAgents().find((a) => a.id === id) ?? claude;
}

/** 按用户写的名字找：标识或显示名，不分大小写。 */
export function findAgent(text: string): Agent | undefined {
  const t = text.trim().toLowerCase();
  return allAgents().find((a) => a.id === t || a.name.toLowerCase() === t || a.name.toLowerCase().replace(/\s+/g, "") === t);
}
