// 可以在聊天里修改的设置，保存在 settings.json。

import { readFileSync, writeFileSync } from "node:fs";
import { following } from "./gating.js";
import { dataFile } from "./config.js";

export interface Settings {
  /** 同一个群两条命令之间至少间隔多少秒；0 表示不限制 */
  intervalSeconds: number;
  /** 持续对话：@ 机器人后，后续不带 @ 的消息也发给它，直到 @ 了别人 */
  follow: boolean;
  /** 危险操作（删除、推送、安装等）先在群里发卡片，批准后才执行 */
  approve: boolean;
  /** 持续对话空闲多少分钟后自动结束；0 表示不自动结束 */
  followIdleMinutes: number;
  /** Claude Code 使用的模型；空字符串表示用它的默认模型 */
  model: string;
  /** Codex 使用的模型；空字符串表示用 Codex 自己配置里的默认模型 */
  codexModel: string;
  /** 没有单独选过的群默认用哪个 agent */
  agent: string;
}

export const SETTINGS_FILE = dataFile("settings.json");

export const MAX_INTERVAL_SECONDS = 3600;

export const MAX_IDLE_MINUTES = 1440;

/** 模型名只允许字母、数字和 . _ - [ ]，为空表示默认 */
export const MODEL_PATTERN = /^[A-Za-z0-9._\-[\]]{0,80}$/;

export function loadSettings(): Settings {
  const defaults: Settings = {
    intervalSeconds: 60,
    follow: true,
    approve: true,
    followIdleMinutes: 10,
    model: "",
    codexModel: "",
    agent: "claude",
  };
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Partial<Settings>;
    const n = raw.intervalSeconds;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_INTERVAL_SECONDS) {
      defaults.intervalSeconds = n;
    }
    if (typeof raw.follow === "boolean") defaults.follow = raw.follow;
    if (typeof raw.approve === "boolean") defaults.approve = raw.approve;
    const idle = raw.followIdleMinutes;
    if (typeof idle === "number" && Number.isInteger(idle) && idle >= 0 && idle <= MAX_IDLE_MINUTES) {
      defaults.followIdleMinutes = idle;
    }
    if (typeof raw.model === "string" && MODEL_PATTERN.test(raw.model)) defaults.model = raw.model;
    if (typeof raw.codexModel === "string" && MODEL_PATTERN.test(raw.codexModel)) defaults.codexModel = raw.codexModel;
    if (typeof raw.agent === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(raw.agent)) defaults.agent = raw.agent;
  } catch {
    // 文件不存在或格式错误时用默认值
  }
  return defaults;
}

export const settings = loadSettings();

/** 设置文件被别处改了（比如在终端里用 chat-agent-bridge set）之后重新读取。返回有没有变化。 */
export function reloadSettings(): boolean {
  const next = loadSettings();
  if (JSON.stringify(next) === JSON.stringify(settings)) return false;
  Object.assign(settings, next);
  if (!settings.follow) following.clear();
  return true;
}

export function describeIdle(): string {
  return settings.followIdleMinutes === 0 ? "不自动结束" : `${settings.followIdleMinutes} 分钟`;
}

export function describeModel(): string {
  return settings.model || "默认";
}

export function describeInterval(): string {
  return settings.intervalSeconds === 0 ? "不限制" : `${settings.intervalSeconds} 秒`;
}

export function setFollow(on: boolean): string {
  settings.follow = on;
  if (!on) following.clear();
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return on
    ? "持续对话已开启：@ 我之后，后续消息不用再 @；@ 了别人就停止，直到再次 @ 我。"
    : "持续对话已关闭：每条消息都要 @ 我才会处理。";
}

export function setApprove(on: boolean): string {
  settings.approve = on;
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return on
    ? "危险操作审批已开启：删除、推送、安装这类操作会先问你。"
    : "危险操作审批已关闭：允许的命令会直接执行，不再询问。读取项目目录以外的文件会被直接拒绝。";
}

export function setFollowIdle(minutes: number): string {
  settings.followIdleMinutes = minutes;
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return minutes === 0
    ? "持续对话不再自动结束。"
    : `持续对话空闲 ${minutes} 分钟后会自动结束，之后需要重新 @ 我。`;
}

export function setModel(model: string): string {
  settings.model = model;
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return model ? `模型已改为 ${model}，下一条指令开始生效。` : "已恢复为默认模型。";
}

export function setCodexModel(model: string): string {
  settings.codexModel = model;
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return model ? `Codex 的模型已改为 ${model}，下一条指令开始生效。` : "Codex 已恢复为它自己的默认模型。";
}

export function setDefaultAgent(agent: string): void {
  settings.agent = agent;
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function setIntervalSeconds(seconds: number): string {
  settings.intervalSeconds = seconds;
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return `已把命令最小间隔改为：${describeInterval()}。`;
}
