// agent 的统一接口。bridge 只通过这个接口跟后面的编程 agent 打交道，
// 所以接入一个新的 agent 只需要：在这个目录里实现 Agent，然后在 index.ts 里登记。

import { type Job } from "../jobs.js";

/** 一次任务里 agent 往外报告的事情。bridge 用它们更新进度卡片和状态。 */
export interface AgentHooks {
  /** 拿到了会话 ID。下一条指令会带着它续上同一个会话 */
  session(id: string): void;
  /** 做了一步操作（读文件、运行命令等），一行人能看懂的话 */
  step(text: string): void;
  /** 正在写的回复。传入的是到目前为止的全文，不是增量 */
  draft(text: string): void;
  /** 这个会话占用的上下文；window 是模型的上下文上限，不知道就不传 */
  context(tokens: number, window?: number): void;
  /** 额度用完了 */
  limit(hit: { type?: string; resetsAt?: number }): void;
}

/** 交给 agent 的一次任务 */
export interface AgentTask {
  /** 任务本身：项目目录在 job.project.cwd，指令在 job.content，停止信号是 job.abort */
  job: Job;
  /** 要续上的会话；没有表示新开一个 */
  sessionId?: string;
}

/** 各个 agent 能力不一样的地方，界面上据此说明或隐藏功能 */
export interface AgentFeatures {
  /** 危险操作能不能先在群里发卡片审批 */
  approvals: boolean;
  /** 能不能压缩会话（/compact） */
  compact: boolean;
}

export interface Agent {
  /** 内部用的标识，也是聊天命令里写的名字，例如 /agent codex */
  id: string;
  /** 显示给人看的名字 */
  name: string;
  /** 一句话说明，显示在切换卡片里 */
  note: string;
  features: AgentFeatures;
  /** 这个 agent 现在用的模型，显示用；空字符串表示用它自己的默认模型 */
  model(): string;
  /** 执行一次任务，返回最终的回复文字。出错时抛出异常；被停止时返回已有的内容即可 */
  run(task: AgentTask, hooks: AgentHooks): Promise<string>;
}

/** 告诉 agent 它正处在什么环境里。各个 agent 按自己的方式放进提示词。 */
export const BRIDGE_PROMPT =
  "你正在通过一个群聊机器人和用户对话。用户多半在手机或另一台设备上，看不到这台电脑的屏幕和文件。" +
  "回复会显示在聊天卡片里，请保持简洁。";
