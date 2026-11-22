// 订阅用量的查询和展示。

import { query, type SDKControlGetUsageResponse, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { button, card, NAV, row } from "./cards.js";
import { CLAUDE_CWD, claudeEnv } from "./config.js";
import { CardReply, Reply } from "./chat.js";
import { logError } from "./log.js";

export type Usage = SDKControlGetUsageResponse;

/**
 * 读取订阅的用量数据（和 Claude Code 里 /usage 看到的是同一份）。
 * 只启动 Claude Code 进程做一次查询，不发送任何提示词，所以不消耗用量。
 * 用的是 SDK 标注为实验性的接口，SDK 升级后可能需要调整。
 */
export async function fetchUsage(): Promise<Usage> {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await hold;
  }
  const q = query({ prompt: idle(), options: { cwd: CLAUDE_CWD, settingSources: [], env: claudeEnv } });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("查询用量超时")), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release();
    await q.return(undefined).catch(() => {});
  }
}

export function bar(percent: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

export function describeReset(iso: string | null | undefined): string {
  if (!iso) return "重置时间未知";
  const at = new Date(iso);
  const minutes = Math.max(0, Math.round((at.getTime() - Date.now()) / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const left = d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
  const when = at.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${when} 重置（还有 ${left}）`;
}

/** 把用量数据整理成若干行：[名称, 百分比或 null, 说明]。 */
export function usageLines(u: Usage): { label: string; percent: number | null; detail: string }[] {
  const limits = u.rate_limits;
  if (!limits) return [];
  const lines: { label: string; percent: number | null; detail: string }[] = [];
  const add = (
    label: string,
    w: { utilization: number | null; resets_at: string | null } | null | undefined,
  ): void => {
    if (w) lines.push({ label, percent: w.utilization, detail: describeReset(w.resets_at) });
  };
  add("5 小时窗口", limits.five_hour);
  add("7 天窗口（全部模型）", limits.seven_day);
  add("7 天窗口（Opus）", limits.seven_day_opus);
  add("7 天窗口（Sonnet）", limits.seven_day_sonnet);
  for (const m of limits.model_scoped ?? []) add(`7 天窗口（${m.display_name}）`, m);
  const extra = limits.extra_usage;
  if (extra) {
    const money = (minor: number | null): string =>
      minor === null ? "未知" : `${(minor / 100).toFixed(2)} ${extra.currency ?? ""}`.trim();
    lines.push({
      label: "额外用量（超出套餐后按量付费）",
      percent: extra.utilization,
      detail: extra.is_enabled
        ? `已用 ${money(extra.used_credits)}，每月上限 ${money(extra.monthly_limit)}`
        : "未开启",
    });
  }
  return lines;
}

export const PLAN_NAMES: Record<string, string> = {
  pro: "Pro",
  max: "Max",
  team: "Team",
  enterprise: "Enterprise",
};

export function usageReply(u: Usage): CardReply {
  const plan = u.subscription_type
    ? (PLAN_NAMES[u.subscription_type] ?? u.subscription_type)
    : "未使用订阅登录";
  const lines = usageLines(u);
  const body = lines.length
    ? lines.map((l) =>
        l.percent === null
          ? `**${l.label}**\n<font color='grey'>${l.detail}</font>`
          : `**${l.label}**　${bar(l.percent)} ${Math.round(l.percent)}%\n<font color='grey'>${l.detail}</font>`,
      )
    : ["当前登录方式没有套餐用量数据。"];
  return {
    card: card("订阅用量", [
      { tag: "markdown", content: `**订阅版本**：Claude ${plan}` },
      { tag: "hr" },
      ...body.map((content) => ({ tag: "markdown", content })),
      { tag: "hr" },
      {
        tag: "markdown",
        content:
          "<font color='grey'>续费日期和账单信息这里查不到，请在 claude.ai 的 Settings > Billing 查看。</font>",
      },
      row("", [button("刷新", { a: "show", view: "usage" }), NAV.use, NAV.setting]),
    ]),
    fallback: [
      `订阅版本：Claude ${plan}`,
      ...lines.map((l) => `${l.label}：${l.percent === null ? "" : Math.round(l.percent) + "%，"}${l.detail}`),
      "续费日期和账单信息请在 claude.ai 的 Settings > Billing 查看。",
    ].join("\n"),
  };
}

export async function usageOrError(): Promise<Reply> {
  try {
    return usageReply(await fetchUsage());
  } catch (err) {
    logError("查询用量出错", err);
    return `查询用量失败：${err instanceof Error ? err.message : String(err)}`;
  }
}
