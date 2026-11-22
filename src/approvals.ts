// 危险操作的审批：发卡片、等待批准或拒绝、超时。

import { type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { button, row } from "./cards.js";
import { BASH_ALLOWED } from "./config.js";
import { Job, scheduleProgress } from "./jobs.js";
import { describeError, patchCard, replyCard, replyText } from "./chat.js";
import { settings } from "./settings.js";
import { log, logError, preview } from "./log.js";

// ----- 危险操作审批 -----

export interface Approval {
  id: string;
  job: Job;
  tool: string;
  detail: string;
  reason: string;
  cardId?: string;
  resolve: (ok: boolean) => void;
}

export const approvals = new Map<string, Approval>();

export let approvalSeq = 0;

export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export function approvalCard(a: Approval, outcome?: "approved" | "denied" | "expired"): object {
  const title =
    outcome === "approved"
      ? "已批准"
      : outcome === "denied"
        ? "已拒绝"
        : outcome === "expired"
          ? "已失效（超时或任务已停止）"
          : "需要你批准";
  const template =
    outcome === "approved" ? "green" : outcome === undefined ? "orange" : "grey";
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: title }, template },
    body: {
      elements: [
        { tag: "markdown", content: `**${a.tool}**　${a.reason}\n项目：${a.job.project.name}` },
        { tag: "markdown", content: "```\n" + a.detail + "\n```" },
        ...(outcome
          ? []
          : [
              row("<font color='grey'>10 分钟内不处理会自动拒绝。也可以发 /approve 或 /deny。</font>", [
                button("批准", { a: "decide", id: a.id, ok: true }, { primary: true }),
                button("拒绝", { a: "decide", id: a.id, ok: false }, { danger: true }),
              ]),
            ]),
      ],
    },
  };
}

/** 处理一条审批。返回更新后的卡片；审批已经不存在时返回 undefined。 */
export function resolveApproval(id: string, ok: boolean): object | undefined {
  const a = approvals.get(id);
  if (!a) return undefined;
  approvals.delete(id);
  a.resolve(ok);
  log("审批", a.job.project.name, ok ? "已批准" : "已拒绝", preview(a.detail, 60));
  return approvalCard(a, ok ? "approved" : "denied");
}

export function askApproval(
  job: Job,
  tool: string,
  toolInput: Record<string, unknown>,
  reason: string,
  signal: AbortSignal,
): Promise<PermissionResult> {
  const filePath = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  const detail = (
    tool === "Bash"
      ? String(toolInput.command ?? "")
      : typeof filePath === "string"
        ? filePath
        : JSON.stringify(toolInput, null, 2)
  ).slice(0, 1500);
  return new Promise<PermissionResult>((done) => {
    const id = `a${++approvalSeq}`;
    const expire = (): void => {
      if (!approvals.delete(id)) return;
      settle(false);
      if (approval.cardId) {
        patchCard(approval.cardId, approvalCard(approval, "expired")).catch(() => {});
      }
    };
    const timer = setTimeout(expire, APPROVAL_TIMEOUT_MS);
    const settle = (ok: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", expire);
      job.steps.push(ok ? `已批准：${tool}` : `已拒绝：${tool}`);
      scheduleProgress(job);
      done(
        ok
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: "用户没有批准这个操作。不要换一种方式绕过，直接说明情况。" },
      );
    };
    const approval: Approval = { id, job, tool, detail, reason, resolve: settle };
    approvals.set(id, approval);
    signal.addEventListener("abort", expire);
    job.steps.push(`等待批准：${tool}`);
    scheduleProgress(job);
    log("审批", job.project.name, `等待批准：${reason}`, preview(detail, 60));
    replyCard(job.messageId, approvalCard(approval))
      .then((id) => {
        approval.cardId = id;
        // 这个平台发不了卡片：改用文字，按下面的斜杠命令批准或拒绝
        if (!id) throw new Error("no cards");
      })
      .catch((err) => {
        if (String(err) !== "Error: no cards") logError("审批卡片发送失败", describeError(err));
        replyText(
          job.messageId,
          `需要你批准：${tool}（${reason}）\n${detail}\n回复 /approve 批准，/deny 拒绝。`,
        ).catch(() => {});
      });
  });
}

export async function decideTool(
  job: Job,
  tool: string,
  toolInput: Record<string, unknown>,
  signal: AbortSignal,
): Promise<PermissionResult> {
  const allow: PermissionResult = { behavior: "allow", updatedInput: toolInput };
  // 有风险的 Bash 命令已经在 PreToolUse 钩子里问过了，到这里的都是普通命令
  if (tool === "Bash" && BASH_ALLOWED) return allow;
  if (!settings.approve) {
    return { behavior: "deny", message: `${tool} 不在允许使用的工具里。` };
  }
  return askApproval(job, tool, toolInput, "这个操作不在自动放行的范围内", signal);
}
