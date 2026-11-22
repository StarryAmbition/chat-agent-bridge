// send_file 工具：把本机文件发到群里。

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { outsideProject, sniffImage } from "./tools.js";
import { askApproval } from "./approvals.js";
import { INBOX_DIR } from "./config.js";
import { Job, scheduleProgress } from "./jobs.js";
import { describeError, replyFile } from "./chat.js";
import { settings } from "./settings.js";
import { logError } from "./log.js";

// ----- 把本机文件发到群里 -----

export const SEND_FILE_TOOL = "mcp__bridge__send_file";

export const MAX_FILE_BYTES = 30 * 1024 * 1024;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 把一个本机文件作为消息发到群里。成功时返回 undefined，失败时返回原因。 */
export async function sendFile(job: Job, rawPath: string): Promise<string | undefined> {
  const path = resolve(job.project.cwd, rawPath);
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return `${path} 不是一个文件。`;
    size = stat.size;
  } catch {
    return `找不到文件 ${path}。`;
  }
  if (size === 0) return "文件是空的，没有发送。";
  if (size > MAX_FILE_BYTES) return `文件有 ${Math.round(size / 1024 / 1024)} MB，超过了 30 MB 的上限。`;

  // 项目目录以外的文件发到群里之前先问一下，避免把不相干的东西发出去
  if (settings.approve && outsideProject(job.project.cwd, path) && outsideProject(INBOX_DIR, path)) {
    const decision = await askApproval(
      job,
      "发送文件",
      { file_path: path },
      "把项目目录以外的文件发到群里",
      job.abort.signal,
    );
    if (decision.behavior !== "allow") return "用户没有批准发送这个文件。";
  }

  const head = Buffer.alloc(16);
  const fd = openSync(path, "r");
  readSync(fd, head, 0, 16, 0);
  closeSync(fd);

  const problem = await replyFile(job.messageId, path, sniffImage(head) && size <= MAX_IMAGE_BYTES ? "image" : "file");
  if (problem) return problem;
  job.steps.push(`发送文件 ${basename(path)}`);
  scheduleProgress(job);
  return undefined;
}

/** 给这一次任务用的工具集：目前只有 send_file。 */
export function bridgeTools(job: Job): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: "bridge",
    version: "1.0.0",
    tools: [
      tool(
        "send_file",
        "把这台电脑上的一个文件发到用户所在的群里，供用户查看或下载。用户看不到这台电脑上的文件，" +
          "所以凡是要交给用户的文件（PDF、图片、表格、文档、压缩包等），都用这个工具发出去，不要只告诉用户路径。",
        { path: z.string().describe("文件的路径，绝对路径或相对于项目目录的路径") },
        async ({ path }) => {
          try {
            const problem = await sendFile(job, path);
            return problem
              ? { content: [{ type: "text" as const, text: `没有发送：${problem}` }], isError: true }
              : { content: [{ type: "text" as const, text: `已把 ${basename(path)} 发到群里。` }] };
          } catch (err) {
            logError("发送文件出错", describeError(err));
            return {
              content: [{ type: "text" as const, text: `发送失败：${describeError(err).slice(0, 300)}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
