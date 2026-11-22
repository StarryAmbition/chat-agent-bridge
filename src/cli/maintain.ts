// 版本、更新、卸载。

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtime } from "./manage.js";
import { serviceRestart, serviceState, serviceUninstall } from "./serviceCmd.js";
import { dataDir } from "./store.js";
import { bold, command, confirm, dim, fail, hint, ok, requireTerminal, say, warn } from "./ui.js";

/** 程序安装在哪个目录（编译后这个文件在 dist/cli/ 下） */
export function installDir(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", installDir(), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/** 版本号，以及是从哪一次提交编译的（不是从 git 仓库安装的就没有后一项）。 */
export function versionInfo(): { version: string; commit?: string } {
  let version = "未知";
  try {
    version = (JSON.parse(readFileSync(join(installDir(), "package.json"), "utf8")) as { version?: string }).version ?? version;
  } catch {
    // 读不到就显示未知
  }
  const commit = existsSync(join(installDir(), ".git")) ? git(["rev-parse", "--short", "HEAD"]) : undefined;
  return { version, ...(commit ? { commit } : {}) };
}

export function showVersion(): void {
  const { version, commit } = versionInfo();
  say(`chat-agent-bridge ${version}${commit ? dim(`（${commit}）`) : ""}`);
  say(dim(`安装位置 ${installDir()}`));
}

function step(title: string, cmd: string, args: string[]): boolean {
  say(dim(`\n${title}…`));
  const res = spawnSync(cmd, args, { cwd: installDir(), stdio: "inherit" });
  if (res.status === 0) return true;
  fail(`${title}失败。`);
  return false;
}

/** 从 git 仓库拉取最新代码，重新安装依赖并编译，然后重启后台服务。 */
export function update(): void {
  const dir = installDir();
  if (!existsSync(join(dir, ".git"))) {
    // 用 npm 装的：交给 npm 更新，然后重启后台服务
    if (!step("通过 npm 更新", "npm", ["install", "-g", "chat-agent-bridge@latest"])) {
      hint("可以手动运行：npm install -g chat-agent-bridge@latest");
      process.exitCode = 1;
      return;
    }
    ok(`现在的版本是 ${versionInfo().version}。`);
    const now = runtime();
    if (now.kind === "service") serviceRestart();
    else if (now.kind === "foreground") warn("bridge 正在终端里运行：到那个终端按 Ctrl+C，再运行 chat-agent-bridge start，新版本才生效。");
    return;
  }
  if (!git(["remote"])) {
    fail("这个仓库没有配置远程地址，没有地方可以拉取更新。");
    hint(`仓库位置：${dir}`);
    process.exitCode = 1;
    return;
  }
  if (git(["status", "--porcelain"])) {
    fail("安装目录里有没提交的改动，为了不覆盖它们，没有更新。");
    hint(`到 ${dir} 里用 git status 看一下，提交或撤销之后再试。`);
    process.exitCode = 1;
    return;
  }
  const before = git(["rev-parse", "HEAD"]);
  if (!step("拉取最新代码", "git", ["pull", "--ff-only"])) {
    hint("常见原因：没有网络；本地的提交和远程分叉了。");
    process.exitCode = 1;
    return;
  }
  if (git(["rev-parse", "HEAD"]) === before) {
    ok("已经是最新版本。");
    return;
  }
  if (!step("安装依赖", "npm", ["install", "--no-audit", "--no-fund"]) || !step("编译", "npm", ["run", "build"])) {
    warn("代码已经更新，但安装依赖或编译没有成功，现在的程序可能无法运行。");
    hint(`到 ${dir} 里手动运行 npm install 和 npm run build 看具体错误。`);
    process.exitCode = 1;
    return;
  }
  const { version, commit } = versionInfo();
  ok(`已更新到 ${version}${commit ? `（${commit}）` : ""}。`);
  const state = runtime();
  if (state.kind === "service") serviceRestart();
  else if (state.kind === "foreground") warn("bridge 正在终端里运行：到那个终端按 Ctrl+C，再运行 chat-agent-bridge start，新版本才生效。");
}

/** 卸载：停掉并移除后台服务；数据要不要删由用户决定；最后告诉用户怎么移除命令本身。 */
export async function uninstall(): Promise<void> {
  requireTerminal();
  say(bold("\n卸载 Chat Agent Bridge\n"));
  const state = runtime();
  if (state.kind === "foreground") {
    fail("bridge 正在终端里运行。先到那个终端按 Ctrl+C 停掉，再来卸载。");
    process.exitCode = 1;
    return;
  }
  if (!(await confirm("确定要卸载吗？", false))) return;

  if (serviceState().installed) serviceUninstall();
  else say(dim("没有安装后台服务，跳过。"));

  const data = dataDir();
  if (existsSync(data)) {
    say(`\n配置和数据在 ${bold(data)}`);
    hint("里面有应用凭证、项目列表、会话记录、白名单、定时任务和日志。");
    if (await confirm("把它们也删掉吗？删了不能恢复。", false)) {
      rmSync(data, { recursive: true, force: true });
      ok("配置和数据已删除。");
    } else {
      say(dim("保留了配置和数据。以后重新安装可以接着用。"));
    }
  }

  say("\n最后一步要你自己执行，移除命令本身：");
  command("npm rm -g chat-agent-bridge");
  hint(`程序的代码在 ${installDir()}，不需要的话可以把这个文件夹删掉。`);
}
