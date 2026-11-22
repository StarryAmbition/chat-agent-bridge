// 终端日志：统一格式（时间、类别、内容），并把账号 ID 显示成名字。不依赖其他模块。

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const COLORS = {
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
} as const;

function paint(text: string, color: keyof typeof COLORS): string {
  return useColor ? `${COLORS[color]}${text}\x1b[0m` : text;
}

/** 类别对应的颜色；没列出的用默认色 */
const TAG_COLORS: Record<string, keyof typeof COLORS> = {
  收到: "cyan",
  命令: "cyan",
  按钮: "cyan",
  任务: "magenta",
  完成: "green",
  停止: "yellow",
  审批: "yellow",
  拦截: "yellow",
  对话: "dim",
  启动: "green",
  连接: "yellow",
  错误: "red",
};

function clock(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/** 打印一行日志：时间、类别、内容。parts 之间用两个空格隔开。 */
export function log(tag: string, ...parts: (string | undefined)[]): void {
  const text = parts.filter(Boolean).join("  ");
  console.log(`${paint(clock(), "dim")}  ${paint(tag, TAG_COLORS[tag] ?? "dim")}  ${text}`);
}

/** 接在上一行下面的补充说明，和内容列对齐。 */
export function logDetail(label: string, text: string): void {
  console.log(`${" ".repeat(10)}${paint(label, "dim")}  ${text}`);
}

/** 打印一条错误：只取错误里有用的那一段，压成一行。 */
export function logError(what: string, err?: unknown): void {
  let detail = "";
  if (err !== undefined) {
    const data = (err as { response?: { data?: unknown } })?.response?.data;
    detail = data ? JSON.stringify(data) : err instanceof Error ? err.message : String(err);
    detail = detail.replace(/\s+/g, " ").slice(0, 300);
  }
  console.error(`${paint(clock(), "dim")}  ${paint("错误", "red")}  ${what}${detail ? `：${detail}` : ""}`);
}

/** 把一段文字压成一行并截短，用来在日志里预览消息内容。 */
export function preview(text: string, max = 50): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ----- 账号名字 -----

const names = new Map<string, string>();

export function rememberName(id: string, name: string): void {
  if (id && name) names.set(id, name);
}

/** 账号在日志里的称呼：知道名字就用名字，否则用 ID 的末尾几位。 */
export function who(id: string): string {
  return names.get(id) ?? (id ? `…${id.slice(-6)}` : "未知");
}

/**
 * 给 Lark SDK 用的日志器：只放行错误。
 * SDK 自己的提示很多（比如每条没人处理的事件都会警告一次、每次建客户端都报一声 ready），
 * 而且它的 loggerLevel 设置对其中一部分不起作用，所以直接换掉。
 */
export const quietLarkLogger = {
  error: (...args: unknown[]): void => logError("Lark SDK", args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
  warn: (): void => {},
  info: (): void => {},
  debug: (): void => {},
  trace: (): void => {},
};
