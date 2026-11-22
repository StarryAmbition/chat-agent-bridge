// 决定一条消息要不要处理：命令间隔限制和持续对话状态。

import { settings } from "./settings.js";
import { log, who } from "./log.js";

export const lastAccepted = new Map<string, number>();

/** 命令可以执行时返回 0 并记录时间；仍在限制期内时返回还需等待的秒数。 */
export function commandWaitSeconds(chatId: string): number {
  const now = Date.now();
  const windowMs = settings.intervalSeconds * 1000;
  const at = lastAccepted.get(chatId);
  if (at !== undefined && now - at < windowMs) {
    return Math.ceil((windowMs - (now - at)) / 1000);
  }
  lastAccepted.set(chatId, now);
  return 0;
}

// 只存在内存里：服务重启后需要重新 @ 一次机器人。

/** "群 ID:发送者 ID" -> 最近一次跟机器人说话的时间 */
export const following = new Map<string, number>();

/**
 * 判断一条群消息是否该交给机器人，并更新持续对话状态。
 * - @ 了机器人：处理；开启持续对话时，这个人进入持续状态
 * - 没 @ 机器人但 @ 了别人：不处理，并退出持续状态
 * - 谁都没 @：只有处于持续状态、而且没有空闲超时，才处理
 */
export function shouldHandleGroupMessage(
  /** "群 ID:发送者 ID"：每个人各自有自己的持续对话状态 */
  key: string,
  mentionsBot: boolean,
  mentionsOthers: boolean,
  now = Date.now(),
): boolean {
  if (mentionsBot) {
    if (settings.follow) following.set(key, now);
    return true;
  }
  if (mentionsOthers) {
    if (following.delete(key)) log("对话", who(key.split(":")[1] ?? ""), "@ 了别人，持续对话结束");
    return false;
  }
  const last = following.get(key);
  if (!settings.follow || last === undefined) return false;
  const idleMs = settings.followIdleMinutes * 60_000;
  if (idleMs > 0 && now - last > idleMs) {
    following.delete(key);
    log("对话", who(key.split(":")[1] ?? ""), "空闲超时，持续对话结束");
    return false;
  }
  following.set(key, now);
  return true;
}
