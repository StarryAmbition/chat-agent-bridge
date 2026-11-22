// 任务的排队与执行：每个（群, 项目）一条队列，进度卡片，交给 agent 执行。

import { agentOf, type AgentHooks } from "./agents/index.js";
import { type Project } from "./projects.js";
import { formatDuration, type ImageType } from "./tools.js";
import { button, row } from "./cards.js";
import { canUseCards, describeError, patchCard, reply, replyCard, replyText } from "./chat.js";
import { store } from "./state.js";
import { describeReset } from "./usage.js";
import { log, logError } from "./log.js";

export type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageType; data: string } };

export interface Job {
  chatId: string;
  /** 会话的范围：群本身，或者群里的一个话题（"群 ID#话题 ID"） */
  scope: string;
  project: Project;
  /** 由哪个 agent 执行（提交时就定下来，执行中途切换不影响这一条） */
  agent: string;
  /** 触发这条任务的消息，结果会引用回复它 */
  messageId: string;
  /** 发指令的人，任务跑得久时完成后会 @ 他 */
  senderId: string;
  /** 指令的开头几十个字，用在进度和状态卡片里 */
  preview: string;
  content: string | Block[];
  startedAt: number;
  steps: string[];
  /** agent 正在写的回复，边生成边显示在进度卡片里 */
  draft: string;
  /** 订阅额度用完时记下来，用来给出明确的提示 */
  limitHit?: { type?: string; resetsAt?: number };
  abort: AbortController;
  /** 进度卡片的 message_id；卡片发不出去时为空，改用普通回复 */
  cardId?: string;
  stopped: boolean;
  finished: boolean;
}

export interface Lane {
  running?: Job;
  pending: Job[];
}

export const lanes = new Map<string, Lane>();

export function laneKey(scope: string, project: Project): string {
  return `${scope}::${project.name}`;
}

export function laneOf(key: string): Lane {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { pending: [] };
    lanes.set(key, lane);
  }
  return lane;
}

export function submit(
  input: Pick<Job, "chatId" | "scope" | "project" | "messageId" | "senderId" | "preview" | "content">,
): void {
  const key = laneKey(input.scope, input.project);
  const lane = laneOf(key);
  const ahead = lane.pending.length + (lane.running ? 1 : 0);
  if (ahead > 0) {
    // 前面有任务在跑：马上说一声，免得以为没收到
    reply(
      input.messageId,
      `已排队，「${input.project.name}」前面还有 ${ahead} 条。发 /status 查看，/stop 可以全部取消。`,
    ).catch((err) => logError("回复出错", err));
  }
  lane.pending.push({
    ...input,
    agent: store.agent(input.scope),
    startedAt: 0,
    steps: [],
    draft: "",
    abort: new AbortController(),
    stopped: false,
    finished: false,
  });
  pump(key);
}

export function pump(key: string): void {
  const lane = laneOf(key);
  if (lane.running) return;
  const job = lane.pending.shift();
  if (!job) return;
  lane.running = job;
  runJob(job)
    .catch((err) => logError("任务出错", err))
    .finally(() => {
      lane.running = undefined;
      pump(key);
    });
}

/** 停掉这条队列上正在跑的任务，并清空排队中的。返回给用户看的说明。 */
export function stopLane(key: string): string {
  const lane = lanes.get(key);
  if (!lane || (!lane.running && lane.pending.length === 0)) return "当前没有正在执行的任务。";
  const dropped = lane.pending.length;
  lane.pending = [];
  if (lane.running) {
    lane.running.stopped = true;
    lane.running.abort.abort();
  }
  return dropped > 0 ? `已停止当前任务，并取消了排队中的 ${dropped} 条。` : "已停止当前任务。";
}

export function runningCount(): number {
  return [...lanes.values()].filter((l) => l.running).length;
}

/** 各会话最近一次的上下文占用，用在状态卡片里。只存在内存里。 */
export const contextUsage = new Map<string, { tokens: number; window?: number }>();

/** 不同 agent 的会话各算各的 */
export function contextKey(scope: string, project: Project, agent: string): string {
  return `${laneKey(scope, project)}::${agent}`;
}

// ----- 进度卡片 -----

export const MAX_CARD_TEXT = 6000;

/** 进度卡片里最多显示正在生成的回复的最后多少个字 */
export const DRAFT_TAIL = 1200;

/** 任务超过这个时长，完成后额外 @ 一下发起人（更新卡片本身不会产生通知） */
export const NOTIFY_AFTER_MS = 60_000;

export const LIMIT_NAMES: Record<string, string> = {
  five_hour: "5 小时窗口",
  seven_day: "7 天窗口",
  seven_day_opus: "7 天窗口（Opus）",
  seven_day_sonnet: "7 天窗口（Sonnet）",
  seven_day_overage_included: "7 天窗口",
  overage: "额外用量",
};

export function limitNotice(hit: NonNullable<Job["limitHit"]>): string {
  const name = hit.type ? (LIMIT_NAMES[hit.type] ?? hit.type) : "订阅";
  // resetsAt 是时间戳，按数值大小判断是秒还是毫秒
  const at = hit.resetsAt ? new Date(hit.resetsAt < 1e12 ? hit.resetsAt * 1000 : hit.resetsAt) : undefined;
  return (
    `**订阅的${name}额度已经用完。**` +
    (at ? `\n${describeReset(at.toISOString())}。` : "") +
    "\n发 `/usage` 可以查看各个窗口的用量；简单的问题可以用 `/model` 换成更省额度的模型。"
  );
}

export function progressCard(job: Job): object {
  const steps = job.steps.slice(-8);
  const hidden = job.steps.length - steps.length;
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: `处理中 · ${job.project.name} · ${agentOf(job.agent).name}` },
      template: "wathet",
    },
    body: {
      elements: [
        { tag: "markdown", content: `<font color='grey'>${job.preview}</font>` },
        {
          tag: "markdown",
          content: steps.length
            ? (hidden > 0 ? `<font color='grey'>…前面还有 ${hidden} 步</font>\n` : "") +
              steps.map((s, i) => `${i === steps.length - 1 ? "▶" : "✓"} ${s}`).join("\n")
            : job.draft
              ? "正在回复…"
              : "正在思考…",
        },
        ...(job.draft
          ? [
              { tag: "hr" },
              {
                tag: "markdown",
                content: (job.draft.length > DRAFT_TAIL ? "…" : "") + job.draft.slice(-DRAFT_TAIL),
              },
            ]
          : []),
        row(`<font color='grey'>已用时 ${formatDuration(Date.now() - job.startedAt)}</font>`, [
          button("停止", { a: "stop", key: laneKey(job.scope, job.project) }, { danger: true }),
        ]),
      ],
    },
  };
}

export function resultCard(job: Job, text: string): object {
  const state = job.stopped ? "已停止" : "完成";
  return {
    schema: "2.0",
    body: {
      elements: [
        { tag: "markdown", content: text },
        {
          tag: "markdown",
          content: `<font color='grey'>${state} · ${job.project.name} · ${agentOf(job.agent).name} · 用时 ${formatDuration(
            Date.now() - job.startedAt,
          )}${job.steps.length ? ` · ${job.steps.length} 步` : ""}</font>`,
        },
      ],
    },
  };
}

/** 进度卡片的更新做了节流：最多每 1.5 秒改一次，避免触发 Lark 的频率限制。 */
export const progressTimers = new Map<Job, NodeJS.Timeout>();

export function scheduleProgress(job: Job): void {
  if (!job.cardId || job.finished || progressTimers.has(job)) return;
  progressTimers.set(
    job,
    setTimeout(() => {
      progressTimers.delete(job);
      if (!job.cardId || job.finished) return;
      patchCard(job.cardId, progressCard(job)).catch((err) =>
        logError("更新进度卡片失败", describeError(err)),
      );
    }, 1500),
  );
}

/** 这个错误是不是"要续上的会话已经不存在"。两个 agent 的说法不一样，都认。 */
export function isSessionGone(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /no conversation found with session id|no rollout found for thread id|(session|thread|conversation)[^\n]{0,40}not found/i.test(text);
}

export async function runJob(job: Job): Promise<void> {
  job.startedAt = Date.now();
  const agent = agentOf(job.agent);
  log("任务", `${job.project.name}（${agent.name}）`, `开始：${job.preview || "（无文字）"}`);
  if (canUseCards()) {
    try {
      job.cardId = await replyCard(job.messageId, progressCard(job));
    } catch (err) {
      logError("进度卡片发送失败，结束后直接回复结果", describeError(err));
    }
  } else {
    // 这个平台发不了可更新的卡片，看不到实时进度：先说一声已经开始
    await replyText(job.messageId, `开始处理（${job.project.name} · ${agent.name}）。完成后把结果发在这里，发 /stop 可以中止。`).catch(
      (err) => logError("回复出错", describeError(err)),
    );
  }

  const usageKey = contextKey(job.scope, job.project, job.agent);
  const hooks: AgentHooks = {
    session: (id) => store.setSession(job.scope, job.project, id, job.preview, Date.now(), job.agent),
    step: (text) => {
      job.steps.push(text);
      scheduleProgress(job);
    },
    draft: (text) => {
      job.draft = text;
      scheduleProgress(job);
    },
    context: (tokens, window) => {
      const prev = contextUsage.get(usageKey);
      contextUsage.set(usageKey, { tokens, ...(window ?? prev?.window ? { window: window ?? prev?.window } : {}) });
    },
    limit: (hit) => {
      job.limitHit = hit;
    },
  };

  let answer: string;
  try {
    const sessionId = store.getSession(job.scope, job.project, job.agent);
    try {
      answer = await agent.run({ job, sessionId }, hooks);
    } catch (err) {
      // 保存的会话在 agent 那边已经不存在了（比如项目目录改过名、会话文件被清理）：
      // 不让用户卡在一个报错上，自动开一个新会话重做这一条
      if (!sessionId || job.stopped || !isSessionGone(err)) throw err;
      log("任务", job.project.name, "原来的会话已经找不到，改用新会话");
      store.clearSession(job.scope, job.project, job.agent);
      const fresh = await agent.run({ job }, hooks);
      answer = `<font color='grey'>原来的会话已经找不到了，这一条是在新会话里处理的，它不记得之前聊过的内容。</font>\n\n${fresh}`;
    }
  } catch (err) {
    if (!job.stopped) logError(`任务出错（${job.project.name}）`, err);
    answer = job.stopped ? "" : `出错了：${err instanceof Error ? err.message : String(err)}`;
  }
  if (job.stopped) answer = answer.trim() ? `${answer}\n\n（任务被手动停止）` : "任务已停止。";
  else if (job.limitHit) answer = limitNotice(job.limitHit) + (answer.trim() ? `\n\n---\n${answer}` : "");
  if (!answer.trim()) answer = "（没有输出）";

  job.finished = true;
  log(
    job.stopped ? "停止" : job.limitHit ? "拦截" : "完成",
    job.project.name,
    `用时 ${formatDuration(Date.now() - job.startedAt)}`,
    job.steps.length ? `${job.steps.length} 步` : undefined,
    job.limitHit ? "订阅额度已用完" : undefined,
  );
  clearTimeout(progressTimers.get(job));
  progressTimers.delete(job);

  if (!job.cardId) {
    await reply(job.messageId, answer);
    return;
  }
  // 结果直接替换掉进度卡片；太长的部分接在后面另发
  const head = answer.slice(0, MAX_CARD_TEXT);
  try {
    await patchCard(job.cardId, resultCard(job, head));
  } catch (err) {
    logError("写入结果卡片失败，改为直接回复", describeError(err));
    await reply(job.messageId, answer);
    return;
  }
  if (answer.length > MAX_CARD_TEXT) await reply(job.messageId, answer.slice(MAX_CARD_TEXT));

  const elapsed = Date.now() - job.startedAt;
  if (elapsed >= NOTIFY_AFTER_MS && !job.stopped) {
    await replyText(job.messageId, `任务完成，用时 ${formatDuration(elapsed)}。结果在上面的卡片里。`, {
      mention: job.senderId,
    }).catch((err) => logError("完成提醒发送失败", describeError(err)));
  }
}
