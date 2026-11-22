// 把 bridge 装成 macOS 的后台服务：开机自启、崩溃后自动拉起、运行期间阻止闲置休眠。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, loadConfig } from "./store.js";
import { bold, command, fail, hint, ok, say, warn } from "./ui.js";

export const LABEL = "com.chat-agent-bridge";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = (): string => `gui/${userInfo().uid}`;

/** 命令行入口文件的路径（编译后的 cli.js） */
function entry(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

export function logPath(): string {
  return join(dataDir(), "logs", "bridge.log");
}

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

export interface ServiceState {
  installed: boolean;
  running: boolean;
  pid?: number;
}

export function serviceState(): ServiceState {
  const res = launchctl(["print", `${domain()}/${LABEL}`]);
  if (!res.ok) return { installed: existsSync(PLIST), running: false };
  const pid = /^\s*pid = (\d+)/m.exec(res.out)?.[1];
  return { installed: true, running: /^\s*state = running/m.test(res.out), ...(pid ? { pid: Number(pid) } : {}) };
}

/** 除了后台服务之外，正在前台运行的 bridge 进程 */
export function foregroundInstances(servicePid?: number): number[] {
  try {
    const out = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      // 只认 node 进程本身：包着它的 shell、caffeinate、tsx 启动器的命令行里也有同样的字样
      .filter((m) => /(^|\/)node$/.test(m[2]))
      .filter((m) => /lark-claude-bridge|chat-agent-bridge|src\/index\.ts|dist\/cli\.js/.test(m[3]) && /\b(start|src\/index\.ts)\b/.test(m[3]))
      .filter((m) => !/\/\.bin\/tsx/.test(m[3]))
      .map((m) => Number(m[1]))
      .filter((pid) => pid && pid !== process.pid && pid !== servicePid);
  } catch {
    return [];
  }
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function serviceInstall(): void {
  if (process.platform !== "darwin") {
    fail("后台服务目前只支持 macOS。");
    process.exit(1);
  }
  if (!loadConfig()) {
    fail("还没有配置。先运行 chat-agent-bridge init。");
    process.exit(1);
  }
  const cli = entry();
  if (!cli.endsWith(".js") || !existsSync(cli)) {
    fail("后台服务要用编译后的程序。请先在项目目录运行 npm run build。");
    process.exit(1);
  }
  const others = foregroundInstances(serviceState().pid);
  if (others.length) {
    fail(`bridge 还在别处运行（进程 ${others.join("、")}）。`);
    hint("同一个应用只会把消息发给其中一个程序。先在那个终端按 Ctrl+C 停掉，再安装后台服务。");
    process.exit(1);
  }
  mkdirSync(dirname(logPath()), { recursive: true });
  mkdirSync(dirname(PLIST), { recursive: true });
  const path = [dirname(process.execPath), join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const args = ["/usr/bin/caffeinate", "-i", process.execPath, cli, "start"];
  writeFileSync(
    PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(path)}</string>
    <key>HOME</key><string>${esc(homedir())}</string>
    <key>BRIDGE_SUPERVISED</key><string>1</string>
    <key>BRIDGE_DATA_DIR</key><string>${esc(dataDir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(logPath())}</string>
  <key>StandardErrorPath</key><string>${esc(logPath())}</string>
</dict>
</plist>
`,
  );
  launchctl(["bootout", `${domain()}/${LABEL}`]);
  launchctl(["enable", `${domain()}/${LABEL}`]);
  const res = launchctl(["bootstrap", domain(), PLIST]);
  if (!res.ok) {
    fail(`启动失败：${res.out.trim()}`);
    process.exit(1);
  }
  ok("后台服务已安装并启动。以后开机会自动运行，崩溃了会自动重新拉起。");
  hint(`日志：${logPath()}`);
  hint("查看状态：chat-agent-bridge service status    看日志：chat-agent-bridge service logs");
  hint("运行期间电脑不会因为闲置而休眠。合上盖子的情况见：chat-agent-bridge awake");
}

export function serviceUninstall(): void {
  launchctl(["bootout", `${domain()}/${LABEL}`]);
  rmSync(PLIST, { force: true });
  ok("后台服务已停止并移除，不会再开机自启。");
}

export function serviceRestart(): void {
  if (!serviceState().installed) {
    fail("后台服务还没有安装。运行 chat-agent-bridge service install。");
    process.exit(1);
  }
  const res = launchctl(["kickstart", "-k", `${domain()}/${LABEL}`]);
  if (res.ok) ok("已重启。");
  else fail(`重启失败：${res.out.trim()}`);
}

export function serviceStatus(): void {
  const state = serviceState();
  if (!state.installed) {
    say("后台服务没有安装。");
    hint("安装：chat-agent-bridge service install");
    return;
  }
  if (state.running) ok(`后台服务正在运行（进程 ${state.pid ?? "?"}）。`);
  else warn("后台服务已安装，但现在没有在运行。看日志找原因：chat-agent-bridge service logs");
  hint(`日志：${logPath()}`);
}

export function serviceLogs(): void {
  if (!existsSync(logPath())) {
    say("还没有日志。");
    return;
  }
  say(bold(`${logPath()}（Ctrl+C 退出）`));
  try {
    execFileSync("tail", ["-n", "60", "-f", logPath()], { stdio: "inherit" });
  } catch {
    // Ctrl+C
  }
}

export function serviceHelp(): void {
  say("用法：");
  command("chat-agent-bridge service install | uninstall | restart | status | logs");
}
