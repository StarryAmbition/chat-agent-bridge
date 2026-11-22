// 判断 bridge 有没有"离线过"：电脑睡眠，或者和聊天平台的连接断开。
// 离线期间发来的消息平台不会补发，所以恢复之后要告诉用户一声。纯逻辑，时间由调用方传入。

/** 两次心跳之间隔了这么久，就认为电脑睡眠过（心跳本来每 30 秒一次） */
export const SLEEP_GAP_MS = 90_000;

/** 睡醒之后等这么久，连接仍然正常，才认为已经恢复 */
export const SETTLE_MS = 60_000;

/** 离线超过这么久才值得提醒 */
export const NOTIFY_AFTER_OFFLINE_MS = 120_000;

export class OutageTracker {
  private lastTick: number;
  private offlineSince?: number;
  private wokeAt?: number;

  constructor(now: number) {
    this.lastTick = now;
  }

  /** 定时调用。离线结束时返回这次离线的时长（毫秒），否则返回 undefined。 */
  tick(now: number, connected: boolean): number | undefined {
    const gap = now - this.lastTick;
    this.lastTick = now;
    if (gap > SLEEP_GAP_MS) {
      // 进程被挂起过：从上一次心跳起就算离线
      this.offlineSince = Math.min(this.offlineSince ?? Infinity, now - gap);
      this.wokeAt = now;
      return undefined;
    }
    if (this.wokeAt !== undefined && connected && now - this.wokeAt >= SETTLE_MS) return this.finish(now);
    return undefined;
  }

  /** 连接断开了 */
  lost(now: number): void {
    this.offlineSince = Math.min(this.offlineSince ?? Infinity, now);
  }

  /** 连接恢复了。返回这次离线的时长；之前没有记录到离线时返回 undefined。 */
  restored(now: number): number | undefined {
    // 刚睡醒时连接可能一断一连好几次，等稳定下来由 tick 统一报告
    if (this.wokeAt !== undefined && now - this.wokeAt < SETTLE_MS) return undefined;
    return this.finish(now);
  }

  private finish(now: number): number | undefined {
    if (this.offlineSince === undefined) return undefined;
    const duration = now - this.offlineSince;
    this.offlineSince = undefined;
    this.wokeAt = undefined;
    return duration;
  }
}
