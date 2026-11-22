// 定时任务：保存、到点触发、以及管理用的卡片。时间规则的解析在 schedule.ts。

import { readFileSync, writeFileSync } from "node:fs";
import { button, card, NAV, row } from "./cards.js";
import { dataFile } from "./config.js";
import { submit } from "./jobs.js";
import { sendText, type CardReply } from "./chat.js";
import { log, logError, preview } from "./log.js";
import { describeSpec, describeTime, nextRun, parseSchedule, SCHEDULE_HELP, type Spec } from "./schedule.js";
import { store } from "./state.js";

export interface Task {
  id: string;
  chatId: string;
  /** 在哪个项目里执行 */
  project: string;
  spec: Spec;
  prompt: string;
  /** 创建者，任务跑得久时完成后会 @ 他 */
  createdBy: string;
  enabled: boolean;
  nextAt?: number;
  lastRunAt?: number;
}

const FILE = dataFile("schedules.json");
const MAX_TASKS = 20;

function load(): Task[] {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as Task[]).filter((t) => t && typeof t.id === "string" && t.spec) : [];
  } catch {
    return [];
  }
}

let tasks: Task[] = load();

function save(): void {
  writeFileSync(FILE, JSON.stringify(tasks, null, 2));
}

export function allTasks(): Task[] {
  return [...tasks];
}

export function listTasks(chatId: string): Task[] {
  return tasks.filter((t) => t.chatId === chatId);
}

/** 新建一个定时任务。text 是 "<时间规则> <指令>"。返回给用户看的结果。 */
export function addTask(chatId: string, project: string, createdBy: string, text: string, now = Date.now()): string {
  if (listTasks(chatId).length >= MAX_TASKS) return `这个群最多 ${MAX_TASKS} 个定时任务，先删掉一些。`;
  const parsed = parseSchedule(text, new Date(now));
  if (typeof parsed === "string") return parsed;
  const task: Task = {
    id: `t${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    chatId,
    project,
    spec: parsed.spec,
    prompt: parsed.prompt,
    createdBy,
    enabled: true,
    nextAt: nextRun(parsed.spec, now),
  };
  tasks.push(task);
  save();
  return (
    `已添加定时任务：${describeSpec(task.spec)}，在「${project}」里执行。\n` +
    `下一次：${task.nextAt ? describeTime(task.nextAt, now) : "不会执行"}\n指令：${task.prompt}`
  );
}

export function removeTask(id: string): Task | undefined {
  const task = tasks.find((t) => t.id === id);
  if (!task) return undefined;
  tasks = tasks.filter((t) => t.id !== id);
  save();
  return task;
}

/** 暂停或恢复。恢复时从现在起重新计算下一次时间。 */
export function toggleTask(id: string, now = Date.now()): Task | undefined {
  const task = tasks.find((t) => t.id === id);
  if (!task) return undefined;
  task.enabled = !task.enabled;
  task.nextAt = task.enabled ? nextRun(task.spec, now) : undefined;
  save();
  return task;
}

/** 立刻执行一次，不影响原来的时间安排。 */
export function runTaskNow(id: string): Task | undefined {
  const task = tasks.find((t) => t.id === id);
  if (task) fire(task).catch((err) => logError("定时任务执行出错", err));
  return task;
}

async function fire(task: Task): Promise<void> {
  const project = store.list().find((p) => p.name === task.project);
  const create = (text: string): Promise<string | undefined> => sendText(task.chatId, text);
  if (!project) {
    task.enabled = false;
    task.nextAt = undefined;
    save();
    await create(`定时任务已暂停：项目「${task.project}」不在项目列表里了。\n指令：${task.prompt}`);
    return;
  }
  log("任务", project.name, `定时触发（${describeSpec(task.spec)}）：${preview(task.prompt)}`);
  // 先在群里发一条消息说明是哪个定时任务，结果会引用回复这条消息
  const messageId = await create(`⏰ 定时任务（${describeSpec(task.spec)}）\n${task.prompt}`);
  if (!messageId) throw new Error("发不出定时任务的起始消息");
  submit({
    chatId: task.chatId,
    scope: task.chatId,
    project,
    messageId,
    senderId: task.createdBy,
    preview: `[定时] ${task.prompt.replace(/\s+/g, " ").slice(0, 50)}`,
    content: task.prompt,
  });
}

function tick(now = Date.now()): void {
  let changed = false;
  for (const task of [...tasks]) {
    if (!task.enabled || task.nextAt === undefined || task.nextAt > now) continue;
    task.lastRunAt = now;
    task.nextAt = nextRun(task.spec, now);
    changed = true;
    fire(task).catch((err) => logError("定时任务执行出错", err));
    // 只执行一次的任务，执行后就删掉
    if (task.nextAt === undefined) tasks = tasks.filter((t) => t.id !== task.id);
  }
  if (changed) save();
}

/** 启动定时器。服务停机期间错过的不补跑，从现在起重新排。 */
export function startScheduler(now = Date.now()): number {
  let changed = false;
  for (const task of [...tasks]) {
    if (!task.enabled || (task.nextAt !== undefined && task.nextAt > now)) continue;
    task.nextAt = nextRun(task.spec, now);
    changed = true;
    if (task.nextAt === undefined) tasks = tasks.filter((t) => t.id !== task.id);
  }
  if (changed) save();
  setInterval(() => tick(), 20_000).unref();
  return tasks.filter((t) => t.enabled).length;
}

export function scheduleCard(chatId: string): CardReply {
  const mine = listTasks(chatId);
  const lines = mine.map(
    (t) =>
      `${describeSpec(t.spec)}　${t.project}　${t.enabled ? `下一次 ${t.nextAt ? describeTime(t.nextAt) : "—"}` : "已暂停"}\n${t.prompt}`,
  );
  return {
    card: card("定时任务", [
      ...(mine.length === 0 ? [{ tag: "markdown", content: "还没有定时任务。" }] : []),
      ...mine.flatMap((t, i) => [
        ...(i > 0 ? [{ tag: "hr" }] : []),
        row(
          `**${describeSpec(t.spec)}**　${t.project}\n${t.prompt}\n<font color='grey'>${
            t.enabled ? `下一次：${t.nextAt ? describeTime(t.nextAt) : "—"}` : "已暂停"
          }${t.lastRunAt ? `　上一次：${describeTime(t.lastRunAt)}` : ""}</font>`,
          [
            button("立即执行", { a: "sched_run", id: t.id }),
            button(t.enabled ? "暂停" : "恢复", { a: "sched_toggle", id: t.id }),
            button("删除", { a: "sched_del", id: t.id }, { danger: true }),
          ],
        ),
      ]),
      { tag: "hr" },
      {
        tag: "markdown",
        content:
          "<font color='grey'>添加：</font>`/schedule add 每天 09:00 检查有没有未提交的改动`\n" +
          `<font color='grey'>${SCHEDULE_HELP.replace(/\n/g, "　|　")}</font>`,
      },
      row("", [button("刷新", { a: "show", view: "schedule" }), NAV.status, NAV.help]),
    ]),
    fallback: [
      mine.length ? "定时任务：" : "还没有定时任务。",
      ...lines.map((l, i) => `${i + 1}. ${l}`),
      "添加：/schedule add 每天 09:00 <指令>；删除：/schedule remove <序号>",
    ].join("\n"),
  };
}
