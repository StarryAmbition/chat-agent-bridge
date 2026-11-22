// 定时任务的时间规则：解析用户写的时间、计算下一次执行时间。都是纯函数，不依赖其他模块。

export type Spec =
  /** 每天（或一周里的某几天）的固定时刻。days 里 0 是周日；不写表示每天 */
  | { kind: "daily"; hour: number; minute: number; days?: number[] }
  /** 每隔若干分钟 */
  | { kind: "every"; minutes: number }
  /** 只执行一次 */
  | { kind: "once"; at: number };

export const MIN_EVERY_MINUTES = 5;

const WEEKDAYS: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];
const TIME = String.raw`(\d{1,2})[:：](\d{2})`;

function validTime(h: number, m: number): boolean {
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

export const SCHEDULE_HELP = [
  "时间可以这样写，后面跟上要执行的指令：",
  "每天 09:00 …",
  "工作日 09:00 …",
  "每周一 09:00 …",
  "每 30 分钟 …　　每 2 小时 …",
  "今天 18:30 …　　明天 08:00 …（只执行一次）",
].join("\n");

/**
 * 解析 "<时间规则> <指令>"。成功时返回规则和指令，失败时返回给用户看的错误说明。
 */
export function parseSchedule(text: string, now = new Date()): { spec: Spec; prompt: string } | string {
  const input = text.trim();
  const withPrompt = (spec: Spec, rest: string): { spec: Spec; prompt: string } | string =>
    rest.trim() ? { spec, prompt: rest.trim() } : "时间后面要写上执行的指令。";

  let m = new RegExp(`^(每天|工作日|每周([一二三四五六日天]))\\s*${TIME}\\s*(.*)$`, "s").exec(input);
  if (m) {
    const hour = Number(m[3]);
    const minute = Number(m[4]);
    if (!validTime(hour, minute)) return "时间要写成 00:00 到 23:59。";
    const days = m[1] === "每天" ? undefined : m[1] === "工作日" ? [1, 2, 3, 4, 5] : [WEEKDAYS[m[2]]];
    return withPrompt({ kind: "daily", hour, minute, ...(days ? { days } : {}) }, m[5]);
  }

  m = /^每\s*(\d+)\s*(分钟|小时)\s*(.*)$/s.exec(input);
  if (m) {
    const minutes = Number(m[1]) * (m[2] === "小时" ? 60 : 1);
    if (minutes < MIN_EVERY_MINUTES) return `间隔最短 ${MIN_EVERY_MINUTES} 分钟。`;
    if (minutes > 7 * 24 * 60) return "间隔最长 7 天。";
    return withPrompt({ kind: "every", minutes }, m[3]);
  }

  m = new RegExp(`^(今天|明天)\\s*${TIME}\\s*(.*)$`, "s").exec(input);
  if (m) {
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    if (!validTime(hour, minute)) return "时间要写成 00:00 到 23:59。";
    const at = new Date(now);
    at.setHours(hour, minute, 0, 0);
    if (m[1] === "明天") at.setDate(at.getDate() + 1);
    if (at.getTime() <= now.getTime()) return "这个时间已经过了。";
    return withPrompt({ kind: "once", at: at.getTime() }, m[4]);
  }

  return `没看懂这个时间。\n${SCHEDULE_HELP}`;
}

/**
 * after 之后的下一次执行时间（毫秒时间戳）。不会再执行时返回 undefined。
 * 对 "every" 规则，从 after 起算一个间隔。
 */
export function nextRun(spec: Spec, after: number): number | undefined {
  if (spec.kind === "once") return spec.at > after ? spec.at : undefined;
  if (spec.kind === "every") return after + spec.minutes * 60_000;
  const candidate = new Date(after);
  candidate.setHours(spec.hour, spec.minute, 0, 0);
  for (let i = 0; i < 8; i++) {
    const dayOk = !spec.days || spec.days.includes(candidate.getDay());
    if (dayOk && candidate.getTime() > after) return candidate.getTime();
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(spec.hour, spec.minute, 0, 0);
  }
  return undefined;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function describeSpec(spec: Spec): string {
  if (spec.kind === "every") {
    return spec.minutes % 60 === 0 ? `每 ${spec.minutes / 60} 小时` : `每 ${spec.minutes} 分钟`;
  }
  if (spec.kind === "once") {
    const at = new Date(spec.at);
    return `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}（一次）`;
  }
  const time = `${pad(spec.hour)}:${pad(spec.minute)}`;
  if (!spec.days) return `每天 ${time}`;
  if (spec.days.join() === "1,2,3,4,5") return `工作日 ${time}`;
  return `每周${spec.days.map((d) => WEEKDAY_NAMES[d]).join("、")} ${time}`;
}

export function describeTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  const dayDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000,
  );
  const day = dayDiff === 0 ? "今天" : dayDiff === 1 ? "明天" : `${d.getMonth() + 1}/${d.getDate()} 周${WEEKDAY_NAMES[d.getDay()]}`;
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
