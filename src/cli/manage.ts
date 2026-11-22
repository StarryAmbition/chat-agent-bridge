// 在终端里修改配置的各项操作。控制面板和单条命令（project / set / allow）都调用这里。

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Allowlist, type Member } from "../allowlist.js";
import { foregroundInstances, serviceState } from "./serviceCmd.js";
import {
  applyEnv,
  dataDir,
  loadProjects,
  saveConfig,
  saveProjects,
  TOOL_LEVELS,
  type BridgeConfig,
} from "./store.js";

export type Level = keyof typeof TOOL_LEVELS;

export const LEVEL_NAMES: Record<Level, string> = {
  readonly: "只读",
  edit: "可以改文件",
  full: "可以改文件并运行命令",
};

export function levelOf(tools: string[]): Level {
  return tools.includes("Bash") ? "full" : tools.includes("Edit") || tools.includes("Write") ? "edit" : "readonly";
}

// ---------- 运行状态 ----------

export type Runtime =
  | { kind: "service"; pid?: number }
  | { kind: "foreground"; pids: number[] }
  | { kind: "stopped"; installed: boolean };

export function runtime(): Runtime {
  const service = serviceState();
  if (service.running) return { kind: "service", ...(service.pid ? { pid: service.pid } : {}) };
  const pids = foregroundInstances(service.pid);
  return pids.length ? { kind: "foreground", pids } : { kind: "stopped", installed: service.installed };
}

export function describeRuntime(state: Runtime): string {
  if (state.kind === "service") return `后台服务运行中（进程 ${state.pid ?? "?"}）`;
  if (state.kind === "foreground") return `在终端里运行中（进程 ${state.pids.join("、")}）`;
  return state.installed ? "没有运行（后台服务已安装但停着）" : "没有运行";
}

// ---------- 项目 ----------

/** 把用户输入的路径（可能带引号、转义空格或 ~）整理成完整路径 */
export function cleanDir(input: string): string {
  const path = input.trim().replace(/\\ /g, " ").replace(/^(['"])(.*)\1$/, "$2");
  return resolve(path.startsWith("~") ? homedir() + path.slice(1) : path);
}

/** 项目名会出现在聊天命令里（/use 名字），所以不能有空白和特殊分隔符 */
export function projectNameProblem(name: string): string | undefined {
  if (!name) return "名字不能为空。";
  if (/[\s:#]/.test(name)) return "名字里不能有空格、冒号或 #。";
  if (name.length > 30) return "名字最长 30 个字符。";
  return undefined;
}

export type Result = { ok: true; text: string } | { ok: false; text: string };

export function addProject(input: string, name?: string): Result {
  const dir = cleanDir(input);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { ok: false, text: `${dir} 不是一个存在的目录。` };
  const finalName = (name ?? "").trim() || basename(dir);
  const problem = projectNameProblem(finalName);
  if (problem) return { ok: false, text: problem };
  const projects = loadProjects();
  const replaced = finalName in projects;
  projects[finalName] = dir;
  saveProjects(projects);
  return { ok: true, text: `${replaced ? "已更新" : "已添加"}项目 ${finalName}：${dir}` };
}

export function removeProject(name: string): Result {
  const projects = loadProjects();
  const key = Object.keys(projects).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return { ok: false, text: `没有叫「${name}」的项目。` };
  if (Object.keys(projects).length === 1) return { ok: false, text: "这是最后一个项目，不能删除。先添加别的项目。" };
  delete projects[key];
  saveProjects(projects);
  return { ok: true, text: `已删除项目 ${key}（只是从列表里去掉，目录本身没有动）。` };
}

// ---------- 权限档位（保存在 config.json，重启后生效） ----------

export function setLevel(config: BridgeConfig, level: Level): Result {
  saveConfig({ ...config, allowedTools: [...TOOL_LEVELS[level]] });
  return { ok: true, text: `权限档位已改为：${LEVEL_NAMES[level]}。` };
}

// ---------- 聊天设置（保存在 settings.json，运行中的 bridge 会自动重新读取） ----------

type SettingsModule = typeof import("../settings.js");

/** bridge 的设置模块在导入时要读配置，所以先把配置写进环境变量再导入。 */
export async function settingsModule(config: BridgeConfig): Promise<SettingsModule> {
  applyEnv(config);
  return import("../settings.js");
}

const ON = ["on", "true", "1", "yes", "开", "是", "开启"];
const OFF = ["off", "false", "0", "no", "关", "否", "关闭"];

function onOff(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  return ON.includes(v) ? true : OFF.includes(v) ? false : undefined;
}

export const SETTING_KEYS = {
  interval: "两条命令之间的最小间隔（秒，0 表示不限制）",
  follow: "持续对话：@ 过一次后不用每句都 @（on / off）",
  idle: "持续对话空闲多少分钟后自动结束（0 表示不自动结束）",
  approve: "危险操作先审批（on / off）",
  model: "Claude Code 使用的模型（default 表示用它的默认模型）",
  "codex-model": "Codex 使用的模型（default 表示用 Codex 自己配置里的模型）",
  agent: "默认用哪个 agent：claude / codex（每个群还可以在聊天里用 /agent 单独选）",
} as const;

/** 可以选的 agent。和 src/agents/index.ts 里登记的保持一致（有测试检查）。 */
export const AGENT_IDS = ["claude", "codex"];

export type SettingKey = keyof typeof SETTING_KEYS;

export function describeSettings(s: SettingsModule): Record<SettingKey, string> {
  return {
    interval: s.describeInterval(),
    follow: s.settings.follow ? "开" : "关",
    idle: s.describeIdle(),
    approve: s.settings.approve ? "开" : "关",
    model: s.describeModel(),
    "codex-model": s.settings.codexModel || "默认",
    agent: s.settings.agent,
  };
}

export function applySetting(s: SettingsModule, key: SettingKey, raw: string): Result {
  const value = raw.trim();
  switch (key) {
    case "interval": {
      const n = Number(value);
      if (!/^\d+$/.test(value) || n > s.MAX_INTERVAL_SECONDS) {
        return { ok: false, text: `间隔要写成 0 到 ${s.MAX_INTERVAL_SECONDS} 之间的整数（秒）。` };
      }
      return { ok: true, text: s.setIntervalSeconds(n) };
    }
    case "idle": {
      const n = Number(value);
      if (!/^\d+$/.test(value) || n > s.MAX_IDLE_MINUTES) {
        return { ok: false, text: `空闲时间要写成 0 到 ${s.MAX_IDLE_MINUTES} 之间的整数（分钟）。` };
      }
      return { ok: true, text: s.setFollowIdle(n) };
    }
    case "follow":
    case "approve": {
      const on = onOff(value);
      if (on === undefined) return { ok: false, text: "这一项要写 on 或 off。" };
      return { ok: true, text: key === "follow" ? s.setFollow(on) : s.setApprove(on) };
    }
    case "model": {
      const model = ["default", "默认", ""].includes(value.toLowerCase()) ? "" : value;
      if (!s.MODEL_PATTERN.test(model)) return { ok: false, text: "模型名只能包含字母、数字和 . _ - [ ]。" };
      return { ok: true, text: s.setModel(model) };
    }
    case "codex-model": {
      const model = ["default", "默认", ""].includes(value.toLowerCase()) ? "" : value;
      if (!s.MODEL_PATTERN.test(model)) return { ok: false, text: "模型名只能包含字母、数字和 . _ - [ ]。" };
      return { ok: true, text: s.setCodexModel(model) };
    }
    case "agent": {
      const id = value.toLowerCase();
      if (!AGENT_IDS.includes(id)) return { ok: false, text: `agent 要写 ${AGENT_IDS.join(" 或 ")}。` };
      s.setDefaultAgent(id);
      return { ok: true, text: `默认的 agent 已改为 ${id}。已经在聊天里用 /agent 单独选过的群不受影响。` };
    }
  }
}

// ---------- 白名单（保存在 allowlist.json，运行中的 bridge 会自动重新读取） ----------

export function allowlistOf(config: BridgeConfig): Allowlist {
  return new Allowlist(join(dataDir(), "allowlist.json"), config.ownerOpenId);
}

export function allowAdd(config: BridgeConfig, id: string, name?: string): Result {
  if (!/^ou_[A-Za-z0-9]+$/.test(id)) {
    return { ok: false, text: "要填对方的 open_id（以 ou_ 开头）。不知道的话，在群里发 /allow 用卡片添加更方便。" };
  }
  if (id === config.ownerOpenId) return { ok: false, text: "这是主人自己，本来就有权限。" };
  const added = allowlistOf(config).add({ id, name: (name ?? "").trim() || id });
  return added ? { ok: true, text: `已把 ${name || id} 加入白名单。` } : { ok: false, text: "这个人已经在白名单里了。" };
}

export function allowRemove(config: BridgeConfig, target: string): Result {
  const list = allowlistOf(config);
  const member: Member | undefined = list
    .list()
    .find((m) => m.id === target || m.name.toLowerCase() === target.toLowerCase());
  if (!member) return { ok: false, text: `白名单里没有「${target}」。` };
  list.remove(member.id);
  return { ok: true, text: `已把 ${member.name} 移出白名单。` };
}

// ---------- 限定的群（保存在 config.json，重启后生效） ----------

export function chatAdd(config: BridgeConfig, id: string): Result {
  if (!/^oc_[A-Za-z0-9]+$/.test(id)) return { ok: false, text: "要填群的 chat_id（以 oc_ 开头）。" };
  if (config.allowedChatIds.includes(id)) return { ok: false, text: "这个群已经在列表里了。" };
  saveConfig({ ...config, allowedChatIds: [...config.allowedChatIds, id] });
  return { ok: true, text: `已添加群 ${id}。` };
}

export function chatRemove(config: BridgeConfig, id: string): Result {
  if (!config.allowedChatIds.includes(id)) return { ok: false, text: "列表里没有这个群。" };
  saveConfig({ ...config, allowedChatIds: config.allowedChatIds.filter((c) => c !== id) });
  return { ok: true, text: `已移除群 ${id}。` };
}
