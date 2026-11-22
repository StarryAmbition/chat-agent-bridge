// 命令行里的输出样式和问答。

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: string) => (text: string): string => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

export const bold = wrap("1");
export const dim = wrap("2");
export const green = wrap("32");
export const yellow = wrap("33");
export const red = wrap("31");
export const cyan = wrap("36");

export const say = (text = ""): void => console.log(text);
export const ok = (text: string): void => console.log(`${green("✓")} ${text}`);
export const warn = (text: string): void => console.log(`${yellow("!")} ${text}`);
export const fail = (text: string): void => console.log(`${red("✗")} ${text}`);
export const hint = (text: string): void => console.log(dim(`  ${text}`));

export function step(n: number, total: number, title: string): void {
  console.log(`\n${bold(cyan(`[${n}/${total}] ${title}`))}`);
}

/** 需要用户自己执行的命令，单独成行方便复制 */
export function command(text: string): void {
  console.log(`\n    ${bold(text)}\n`);
}

const rl = (): ReturnType<typeof createInterface> =>
  createInterface({ input: process.stdin, output: process.stdout });

export async function ask(question: string, fallback = ""): Promise<string> {
  const io = rl();
  try {
    const answer = (await io.question(`${question}${fallback ? dim(` (${fallback})`) : ""} `)).trim();
    return answer || fallback;
  } catch (err) {
    // 在提问时按了 Ctrl+C 或 Ctrl+D：安静地退出，不打印一屏错误
    if ((err as { code?: string })?.code === "ABORT_ERR") {
      console.log(dim("\n已退出，没有保存的改动不会生效。"));
      process.exit(130);
    }
    throw err;
  } finally {
    io.close();
  }
}

/** 询问密钥这类不该留在屏幕上的内容：输入时不回显。 */
export async function askSecret(question: string): Promise<string> {
  // readline 把回显也写到输出里：提问显示出来之后，把后面写出的内容都吞掉
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const io = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  try {
    const pending = io.question(`${question} `);
    muted = true;
    const answer = (await pending).trim();
    console.log(dim(answer ? `\n  已输入 ${answer.length} 个字符（不显示）` : ""));
    return answer;
  } catch (err) {
    if ((err as { code?: string })?.code === "ABORT_ERR") {
      console.log(dim("\n已退出，没有保存的改动不会生效。"));
      process.exit(130);
    }
    throw err;
  } finally {
    io.close();
  }
}

export async function confirm(question: string, fallback = true): Promise<boolean> {
  const answer = (await ask(`${question} ${dim(fallback ? "[Y/n]" : "[y/N]")}`)).toLowerCase();
  if (!answer) return fallback;
  return ["y", "yes", "是", "好"].includes(answer);
}

/** 从几个选项里选一个，返回选中项的 value。 */
export async function choose<T>(question: string, options: { label: string; note?: string; value: T }[], fallback = 1): Promise<T> {
  say(question);
  options.forEach((o, i) => say(`  ${bold(String(i + 1))}. ${o.label}${o.note ? dim(`  ${o.note}`) : ""}`));
  for (;;) {
    const answer = await ask("请输入序号", String(fallback));
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && options[index]) return options[index].value;
    warn(`请输入 1 到 ${options.length} 之间的数字。`);
  }
}

/** 菜单：选一项返回它的 value；选 0 或直接回车返回 undefined（表示返回上一级或退出）。 */
export async function menu<T>(
  title: string,
  options: { label: string; note?: string; value: T }[],
  back = "返回上一级",
): Promise<T | undefined> {
  say(`\n${bold(cyan(title))}`);
  const width = Math.max(...options.map((o) => displayWidth(o.label)));
  options.forEach((o, i) => {
    say(`  ${bold(String(i + 1).padStart(2))}. ${o.note ? `${padTo(o.label, width)}  ${dim(o.note)}` : o.label}`);
  });
  say(`  ${bold(" 0")}. ${back}`);
  for (;;) {
    const answer = await ask(dim("输入序号："));
    if (!answer || answer === "0") return undefined;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && options[index]) return options[index].value;
    warn(`请输入 0 到 ${options.length} 之间的数字。`);
  }
}

/** 终端里的显示宽度：中文等全角字符占两格 */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return w;
}

/** 按显示宽度补空格到指定宽度 */
export function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function requireTerminal(): void {
  if (!process.stdin.isTTY) {
    fail("这个命令需要在终端里交互运行。");
    process.exit(1);
  }
}
