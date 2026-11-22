// Codex：通过 Codex SDK 调用这台电脑上的 Codex（用的是本机 Codex 已有的登录）。

import { Codex, type ThreadItem, type ThreadOptions, type UserInput } from "@openai/codex-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ALLOWED_TOOLS, INBOX_DIR } from "../config.js";
import { sendFile } from "../files.js";
import { type Job } from "../jobs.js";
import { settings } from "../settings.js";
import { BRIDGE_PROMPT, type Agent } from "./types.js";

// Codex 没有 send_file 工具，改成约定一种写法：回复里单独一行的标记，由 bridge 识别后发送
const PROMPT =
  BRIDGE_PROMPT +
  "需要把文件交给用户时（比如生成的 PDF、图片、表格），在回复里单独写一行 [[send_file: 文件的绝对路径]]，" +
  "机器人会把这个文件发到群里；不要只给出本机路径。";

const SEND_FILE_LINE = /^[ \t]*\[\[send_file:\s*(.+?)\s*\]\][ \t]*$/gm;

/**
 * 权限档位对应到 Codex 自带的沙箱。Codex 在这里没有逐条审批，靠沙箱限制它能碰到什么：
 * - 只读：不能改任何文件
 * - 可以改文件：只能写项目目录，不能联网
 * - 可以改文件并运行命令：只能写项目目录，可以联网
 * 注意后两档里 Codex 都能在沙箱内运行命令，这一点和 Claude Code 的"可以改文件"不同。
 */
export function sandboxFor(tools: string[]): Pick<ThreadOptions, "sandboxMode" | "networkAccessEnabled"> {
  if (!tools.includes("Edit") && !tools.includes("Write")) return { sandboxMode: "read-only" };
  return { sandboxMode: "workspace-write", networkAccessEnabled: tools.includes("Bash") };
}

/** Codex 报告的命令外面包着一层 shell，显示时去掉 */
export function plainCommand(command: string): string {
  const m = /^(?:\/\S+\/)?(?:zsh|bash|sh)\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  if (!m) return command.trim();
  const inner = m[1].trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(inner);
  return (quoted ? quoted[2] : inner).trim();
}

function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** 把 Codex 的一项操作写成一行人能看懂的话；不需要显示的返回 undefined。 */
export function describeItem(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "command_execution":
      return `运行 ${short(plainCommand(item.command), 70)}`;
    case "file_change": {
      const names = item.changes.map((c) => basename(c.path));
      const verb = item.changes.every((c) => c.kind === "add")
        ? "写入"
        : item.changes.every((c) => c.kind === "delete")
          ? "删除"
          : "修改";
      return `${verb} ${short(names.join("、"), 60)}${item.status === "failed" ? "（失败）" : ""}`;
    }
    case "web_search":
      return `联网搜索 ${short(item.query, 50)}`;
    case "mcp_tool_call":
      return `使用 ${item.server}.${item.tool}`;
    default:
      return undefined;
  }
}

/** 取出回复里的发文件标记。返回去掉标记后的文字和要发送的路径。 */
export function extractSendFiles(text: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const cleaned = text.replace(SEND_FILE_LINE, (_line, path: string) => {
    paths.push(path.replace(/^(['"`])(.*)\1$/, "$2"));
    return "";
  });
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trim(), paths };
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** 把任务内容转成 Codex 的输入。Codex 只接受本机图片文件，所以图片先落盘。 */
function toInput(job: Job, prefix: string): string | UserInput[] {
  if (typeof job.content === "string") return prefix + job.content;
  const dir = join(INBOX_DIR, "codex");
  mkdirSync(dir, { recursive: true });
  const input: UserInput[] = [];
  let first = true;
  job.content.forEach((block, i) => {
    if (block.type === "text") {
      input.push({ type: "text", text: (first ? prefix : "") + block.text });
      first = false;
    } else {
      const path = join(dir, `${job.messageId.replace(/[^\w-]/g, "_")}-${i}.${EXT[block.source.media_type] ?? "png"}`);
      writeFileSync(path, Buffer.from(block.source.data, "base64"));
      input.push({ type: "local_image", path });
    }
  });
  if (first && prefix) input.unshift({ type: "text", text: prefix.trim() });
  return input;
}

export const codex: Agent = {
  id: "codex",
  name: "Codex",
  note: "没有逐条审批，靠自带的沙箱限制：只能改项目目录里的文件",
  features: { approvals: false, compact: false },
  model: () => settings.codexModel,

  async run({ job, sessionId }, hooks) {
    const options: ThreadOptions = {
      workingDirectory: job.project.cwd,
      skipGitRepoCheck: true,
      // 没有人在终端前回答 Codex 的询问，所以不让它询问：沙箱不允许的操作直接失败
      approvalPolicy: "never",
      ...sandboxFor(ALLOWED_TOOLS),
      ...(settings.codexModel ? { model: settings.codexModel } : {}),
    };
    const client = new Codex();
    const thread = sessionId ? client.resumeThread(sessionId, options) : client.startThread(options);
    // 新会话的第一条消息前面加上环境说明；续上的会话里它已经知道了
    const input = toInput(job, sessionId ? "" : `${PROMPT}\n\n---\n\n`);

    let answer = "";
    const problems: string[] = [];
    try {
      const { events } = await thread.runStreamed(input, { signal: job.abort.signal });
      for await (const event of events) {
        if (event.type === "thread.started") {
          hooks.session(event.thread_id);
        } else if (event.type === "item.started") {
          // 命令开始时就显示，其余的等完成后再显示
          if (event.item.type === "command_execution") hooks.step(describeItem(event.item)!);
        } else if (event.type === "item.completed") {
          const item = event.item;
          if (item.type === "agent_message") {
            const { text, paths } = extractSendFiles(item.text);
            for (const path of paths) {
              const problem = await sendFile(job, path).catch((err) => String(err));
              if (problem) problems.push(`没有发送 ${basename(path)}：${problem}`);
            }
            answer = text;
            hooks.draft(answer);
          } else if (item.type === "error") {
            problems.push(item.message);
          } else if (item.type !== "command_execution") {
            const step = describeItem(item);
            if (step) hooks.step(step);
          }
        } else if (event.type === "turn.completed") {
          hooks.context(event.usage.input_tokens);
        } else if (event.type === "turn.failed") {
          throw new Error(event.error.message);
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    } catch (err) {
      // 被 /stop 停掉时把已经写出来的内容交回去
      if (!job.abort.signal.aborted) throw err;
    }
    return [answer, ...problems].filter(Boolean).join("\n\n");
  },
};
