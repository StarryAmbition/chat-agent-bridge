// Claude Code：通过 Claude Agent SDK 调用这台电脑上的 Claude Code。

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { APPROVAL_TIMEOUT_MS, askApproval, decideTool } from "../approvals.js";
import { ALLOWED_TOOLS, claudeEnv, INBOX_DIR, PERMISSION_MODE } from "../config.js";
import { bridgeTools, SEND_FILE_TOOL } from "../files.js";
import { settings } from "../settings.js";
import { describeStep, isReadTool, outsideProject, readsOutside, riskOf } from "../tools.js";
import { BRIDGE_PROMPT, type Agent } from "./types.js";

const PROMPT =
  BRIDGE_PROMPT +
  "需要把文件交给用户时（比如生成的 PDF、图片、表格），调用 send_file 工具把文件发到群里，不要只给出本机路径。";

// Bash 不放进自动放行的列表，这样每条命令都会先经过 decideTool 判断风险
const AUTO_ALLOWED_TOOLS = ALLOWED_TOOLS.filter((t) => t !== "Bash");

export const claude: Agent = {
  id: "claude",
  name: "Claude Code",
  note: "危险操作会先发卡片审批；可以把文件发回群里",
  features: { approvals: true, compact: true },
  model: () => settings.model,

  async run({ job, sessionId }, hooks) {
    let result = "";
    let tokens = 0;

    // 用流式输入：发完这一条后保持输入通道打开，审批的往返才走得通
    let closeInput!: () => void;
    const inputClosed = new Promise<void>((r) => (closeInput = r));
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: "user",
        message: { role: "user", content: job.content },
        parent_tool_use_id: null,
        session_id: "",
      } as SDKUserMessage;
      await inputClosed;
    }

    const stream = query({
      prompt: input(),
      options: {
        cwd: job.project.cwd,
        resume: sessionId,
        allowedTools: [...AUTO_ALLOWED_TOOLS, SEND_FILE_TOOL],
        permissionMode: PERMISSION_MODE,
        settingSources: ["user", "project", "local"],
        // 用 Claude Code 自己的系统提示词，再补充一段说明当前是在群聊里
        systemPrompt: { type: "preset", preset: "claude_code", append: PROMPT },
        mcpServers: { bridge: bridgeTools(job) },
        env: claudeEnv,
        abortController: job.abort,
        ...(settings.model ? { model: settings.model } : {}),
        includePartialMessages: true,
        canUseTool: (tool, toolInput, opts) => decideTool(job, tool, toolInput, opts.signal),
        // 危险命令的审批放在 PreToolUse 钩子里：它在所有放行规则之前执行，
        // 所以即使你的 Claude Code 设置里已经允许了某些命令，也照样会先问
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit|Read|NotebookRead|Glob|Grep",
              timeout: APPROVAL_TIMEOUT_MS / 1000 + 60,
              hooks: [
                async (hookInput, _toolUseId, opts) => {
                  if (hookInput.hook_event_name !== "PreToolUse") return {};
                  const tool = hookInput.tool_name;
                  const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
                  // 读取默认只限项目目录（以及临时目录和用户发来的附件）。
                  // 超出范围的先问；审批关着没法问的时候直接拒绝，不能悄悄放行
                  if (isReadTool(tool)) {
                    if (!readsOutside(job.project.cwd, tool, toolInput, [INBOX_DIR])) return {};
                    const allowed = settings.approve
                      ? (await askApproval(job, tool, toolInput, "读取项目目录以外的文件", opts.signal)).behavior === "allow"
                      : false;
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: allowed ? "allow" : "deny",
                        permissionDecisionReason: allowed
                          ? "用户已批准"
                          : settings.approve
                            ? "用户没有批准读取项目目录以外的文件。不要换一种方式绕过，直接说明情况。"
                            : "只能读取项目目录里的文件。不要换一种方式绕过，直接说明情况。",
                      },
                    };
                  }
                  if (!settings.approve) return {};
                  const reason =
                    tool === "Bash"
                      ? riskOf(String(toolInput.command ?? ""))
                      : outsideProject(job.project.cwd, toolInput.file_path ?? toolInput.notebook_path)
                        ? "修改项目目录以外的文件"
                        : undefined;
                  if (!reason) return {};
                  const decision = await askApproval(job, tool, toolInput, reason, opts.signal);
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: decision.behavior === "allow" ? "allow" : "deny",
                      permissionDecisionReason:
                        decision.behavior === "allow" ? "用户已批准" : decision.message,
                    },
                  };
                },
              ],
            },
          ],
        },
      },
    });

    let draft = "";
    try {
      for await (const msg of stream) {
        if (msg.type === "system" && msg.subtype === "init") {
          hooks.session(msg.session_id);
        } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
          const u = msg.message.usage;
          if (u) {
            tokens =
              (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            hooks.context(tokens);
          }
          for (const block of msg.message.content) {
            // 发文件这一步由 send_file 自己记录
            if (block.type === "tool_use" && block.name !== SEND_FILE_TOOL) {
              hooks.step(describeStep(block.name, block.input as Record<string, unknown>));
            }
          }
        } else if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
          // 回复边生成边显示：每条新消息开始时清空，文字增量追加
          const event = msg.event;
          if (event.type === "message_start") {
            draft = "";
            hooks.draft(draft);
          } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            draft += event.delta.text;
            hooks.draft(draft);
          }
        } else if (msg.type === "rate_limit_event") {
          const info = msg.rate_limit_info;
          if (info.status === "rejected") hooks.limit({ type: info.rateLimitType, resetsAt: info.resetsAt });
        } else if (msg.type === "result") {
          result = msg.subtype === "success" ? msg.result : `这一轮没有正常结束（${msg.subtype}）。`;
          const windows = Object.values(msg.modelUsage ?? {}).map((m) => m.contextWindow ?? 0);
          const window = Math.max(0, ...windows);
          if (window > 0) hooks.context(tokens, window);
          closeInput();
        }
      }
    } finally {
      closeInput();
    }
    return result;
  },
};
