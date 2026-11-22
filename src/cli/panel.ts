// 终端里的控制面板：不带参数运行 chat-agent-bridge 时进入，所有配置都能在这里改。

import { existsSync } from "node:fs";
import {
  addProject,
  allowAdd,
  allowlistOf,
  allowRemove,
  applySetting,
  chatAdd,
  chatRemove,
  describeRuntime,
  describeSettings,
  LEVEL_NAMES,
  levelOf,
  removeProject,
  runtime,
  SETTING_KEYS,
  setLevel,
  settingsModule,
  type Level,
  type Result,
  type SettingKey,
} from "./manage.js";
import { serviceInstall, serviceLogs, serviceRestart, serviceUninstall } from "./serviceCmd.js";
import { dataDir, loadConfig, loadProjects, saveConfig, type BridgeConfig } from "./store.js";
import { ask, bold, confirm, dim, fail, green, hint, menu, ok, requireTerminal, say, warn, yellow } from "./ui.js";

function report(result: Result): boolean {
  if (result.ok) ok(result.text);
  else fail(result.text);
  return result.ok;
}

/** 改动保存在 settings.json / allowlist.json / projects.json：运行中的 bridge 会自己读到。 */
export function noteLive(): void {
  if (runtime().kind !== "stopped") hint("运行中的 bridge 会在几秒内自动读到，不用重启。");
}

/** 改动保存在 config.json：要重启 bridge 才生效。interactive 为 false 时只说明，不提问。 */
export async function noteRestart(interactive: boolean): Promise<void> {
  const state = runtime();
  if (state.kind === "stopped") {
    hint("下次启动时生效。");
    return;
  }
  if (state.kind === "foreground") {
    warn("这项改动要重启才生效：到运行 bridge 的那个终端按 Ctrl+C，再运行 chat-agent-bridge start。");
    return;
  }
  if (!interactive) {
    warn("这项改动要重启才生效：chat-agent-bridge service restart");
    return;
  }
  if (await confirm("这项改动要重启后台服务才生效。现在重启吗？（正在执行的任务会中断）")) serviceRestart();
  else hint("之后运行 chat-agent-bridge service restart 生效。");
}

export function printStatus(config: BridgeConfig): void {
  const state = runtime();
  const projects = Object.keys(loadProjects());
  const dot = state.kind === "stopped" ? yellow("○") : green("●");
  say(`  状态        ${dot} ${describeRuntime(state)}`);
  say(`  机器人      ${config.appId}（${config.domain === "lark" ? "Lark 国际版" : "飞书国内版"}）`);
  say(`  调用方式    ${config.authMode === "api_key" ? "API key" : "Claude Code 订阅登录"}`);
  say(`  权限档位    ${LEVEL_NAMES[levelOf(config.allowedTools)]}`);
  say(`  项目        ${projects.join("、") || dim("未设置")}`);
  say(dim(`  数据目录    ${dataDir()}`));
}

// ---------- 各个子菜单 ----------

async function projectsMenu(): Promise<void> {
  for (;;) {
    const projects = Object.entries(loadProjects());
    say(`\n${bold("项目目录")}  ${dim("Claude 只在这些目录里工作，在群里用 /use 切换")}`);
    for (const [name, dir] of projects) say(`  ${name}  ${dim(dir)}${existsSync(dir) ? "" : yellow("  目录不存在")}`);
    const action = await menu("要做什么？", [
      { label: "添加项目", value: "add" as const },
      { label: "删除项目", value: "remove" as const },
    ]);
    if (!action) return;
    if (action === "add") {
      const input = await ask("项目目录的路径（可以把文件夹拖进终端）：");
      if (!input) continue;
      const name = await ask("给它起个短名字，直接回车用文件夹名：");
      if (report(addProject(input, name))) noteLive();
    } else {
      const name = await menu(
        "删除哪一个？",
        projects.map(([n, dir]) => ({ label: n, note: dir, value: n })),
        "取消",
      );
      if (name && report(removeProject(name))) noteLive();
    }
  }
}

async function levelMenu(config: BridgeConfig): Promise<void> {
  say(`\n${bold("权限档位")}  ${dim(`现在是：${LEVEL_NAMES[levelOf(config.allowedTools)]}`)}`);
  const level = await menu<Level>(
    "改成哪一档？",
    [
      { label: LEVEL_NAMES.readonly, note: "只能看文件、搜索，不能改任何东西", value: "readonly" },
      { label: LEVEL_NAMES.edit, note: "能编辑和新建文件，不能运行命令", value: "edit" },
      { label: LEVEL_NAMES.full, note: "删除、推送、安装这类危险操作会先问你", value: "full" },
    ],
    "不改",
  );
  if (!level || level === levelOf(config.allowedTools)) return;
  if (level === "full") warn("审批是按命令文字判断的，藏在脚本里的操作拦不住。不要把它当成安全边界。");
  report(setLevel(config, level));
  await noteRestart(true);
}

async function settingsMenu(config: BridgeConfig): Promise<void> {
  const s = await settingsModule(config);
  const labels: Record<SettingKey, string> = {
    interval: "命令间隔",
    follow: "持续对话",
    idle: "持续对话空闲多久结束",
    approve: "危险操作审批",
    model: "Claude Code 的模型",
    "codex-model": "Codex 的模型",
    agent: "默认的 agent",
  };
  for (;;) {
    const now = describeSettings(s);
    const key = await menu<SettingKey>(
      "聊天设置",
      (Object.keys(labels) as SettingKey[]).map((k) => ({ label: labels[k], note: now[k], value: k })),
    );
    if (!key) return;
    let value: string;
    if (key === "follow" || key === "approve") {
      // 开关类的直接切换
      value = s.settings[key] ? "off" : "on";
      if (key === "approve" && value === "off") {
        warn("关闭后，允许的命令会直接执行，包括删除文件、推送代码这类操作。");
        if (!(await confirm("确定关闭吗？", false))) continue;
      }
    } else {
      say(dim(SETTING_KEYS[key]));
      value = await ask("新的值，直接回车不改：");
      if (!value) continue;
    }
    if (report(applySetting(s, key, value))) noteLive();
  }
}

async function allowMenu(config: BridgeConfig): Promise<void> {
  for (;;) {
    const members = allowlistOf(config).list();
    say(`\n${bold("白名单")}  ${dim("除了你之外，还允许指挥机器人的人")}`);
    if (config.authMode === "subscription") {
      warn("现在是订阅登录，按订阅条款只有你本人能指挥；白名单要切换到 API key 方式后才生效。");
    }
    if (members.length === 0) say(dim("  （空）"));
    for (const m of members) say(`  ${m.name}  ${dim(m.id)}`);
    const action = await menu("要做什么？", [
      { label: "添加", note: "需要对方的 open_id；在群里发 /allow 用卡片添加更方便", value: "add" as const },
      { label: "移除", value: "remove" as const },
    ]);
    if (!action) return;
    if (action === "add") {
      const id = await ask("对方的 open_id（ou_ 开头）：");
      if (!id) continue;
      const name = await ask("怎么称呼：");
      if (report(allowAdd(config, id, name))) noteLive();
    } else {
      if (members.length === 0) {
        say("白名单是空的。");
        continue;
      }
      const id = await menu("移除谁？", members.map((m) => ({ label: m.name, note: m.id, value: m.id })), "取消");
      if (id && report(allowRemove(config, id))) noteLive();
    }
  }
}

async function chatsMenu(): Promise<void> {
  let changed = false;
  for (;;) {
    const config = loadConfig();
    if (!config) return;
    say(`\n${bold("限定的群")}  ${dim("只在这些群里响应；列表为空表示机器人所在的任何群都响应")}`);
    if (config.allowedChatIds.length === 0) say(dim("  （不限）"));
    for (const id of config.allowedChatIds) say(`  ${id}`);
    const action = await menu("要做什么？", [
      { label: "添加一个群", note: "需要群的 chat_id；也可以重新运行向导，在新群里 @ 机器人来识别", value: "add" as const },
      { label: "移除一个群", value: "remove" as const },
    ]);
    if (!action) break;
    if (action === "add") {
      const id = await ask("群的 chat_id（oc_ 开头）：");
      if (id && report(chatAdd(config, id))) changed = true;
    } else {
      if (config.allowedChatIds.length === 0) {
        say("列表是空的。");
        continue;
      }
      const id = await menu("移除哪一个？", config.allowedChatIds.map((c) => ({ label: c, value: c })), "取消");
      if (!id) continue;
      if (config.allowedChatIds.length === 1) {
        warn("移除后列表为空，机器人会在它所在的任何群里响应你。");
        if (!(await confirm("确定吗？", false))) continue;
      }
      if (report(chatRemove(config, id))) changed = true;
    }
  }
  if (changed) await noteRestart(true);
}

async function authMenu(config: BridgeConfig): Promise<void> {
  say(`\n${bold("Claude 调用方式")}  ${dim(`现在是：${config.authMode === "api_key" ? "API key" : "Claude Code 订阅登录"}`)}`);
  if (!(await confirm("要重新选择吗？", false))) return;
  const { chooseClaudeAuth } = await import("./init.js");
  const auth = await chooseClaudeAuth();
  const { apiKey: _old, ...rest } = config;
  saveConfig({ ...rest, authMode: auth.authMode, ...(auth.apiKey ? { apiKey: auth.apiKey } : {}) });
  ok(`调用方式已改为：${auth.authMode === "api_key" ? "API key" : "Claude Code 订阅登录"}。`);
  await noteRestart(true);
}

/** 返回 true 表示要退出面板并在当前终端启动 bridge。 */
async function runMenu(): Promise<boolean> {
  for (;;) {
    const state = runtime();
    say(`\n${bold("启动与后台服务")}  ${dim(describeRuntime(state))}`);
    type Action = "start" | "install" | "restart" | "uninstall" | "logs" | "awake";
    const options: { label: string; note?: string; value: Action }[] = [];
    if (state.kind === "stopped") {
      options.push({ label: "在这个终端启动", note: "关掉窗口就停；Ctrl+C 停止", value: "start" });
    }
    if (state.kind === "service" || (state.kind === "stopped" && state.installed)) {
      options.push({ label: "重启后台服务", value: "restart" });
      options.push({ label: "看后台服务的日志", note: "Ctrl+C 退出", value: "logs" });
      options.push({ label: "停止并移除后台服务", note: "不再开机自启", value: "uninstall" });
    } else {
      options.push({ label: "装成后台服务", note: "开机自启，崩溃自动恢复，不因闲置休眠", value: "install" });
    }
    options.push({ label: "合上盖子也保持运行", note: "几种办法和各自的代价", value: "awake" });
    const action = await menu("要做什么？", options);
    if (!action) return false;
    if (action === "start") return true;
    if (action === "install") {
      if (state.kind === "foreground") {
        warn("bridge 正在另一个终端里运行。先到那个终端按 Ctrl+C 停掉，再来安装后台服务。");
        continue;
      }
      serviceInstall();
    } else if (action === "restart") serviceRestart();
    else if (action === "logs") serviceLogs();
    else if (action === "uninstall") {
      if (await confirm("确定停止并移除后台服务吗？", false)) serviceUninstall();
    } else (await import("./awake.js")).runAwake();
  }
}

/** 返回 true 表示用户选择了在当前终端启动 bridge。 */
export async function runPanel(): Promise<boolean> {
  requireTerminal();
  for (;;) {
    const config = loadConfig();
    if (!config) {
      fail("还没有配置。先运行 chat-agent-bridge init。");
      process.exitCode = 1;
      return false;
    }
    say(bold("\nChat Agent Bridge 控制面板\n"));
    printStatus(config);
    const members = allowlistOf(config).list().length;
    type Item = "run" | "projects" | "level" | "settings" | "allow" | "chats" | "auth" | "init" | "doctor";
    const item = await menu<Item>(
      "要管理什么？",
      [
        { label: "启动与后台服务", note: "启动、重启、开机自启、看日志、合盖运行", value: "run" },
        { label: "项目目录", note: `${Object.keys(loadProjects()).length} 个`, value: "projects" },
        { label: "权限档位", note: LEVEL_NAMES[levelOf(config.allowedTools)], value: "level" },
        { label: "聊天设置", note: "命令间隔、持续对话、危险操作审批、模型、默认 agent", value: "settings" },
        { label: "白名单", note: members ? `${members} 人` : "空", value: "allow" },
        { label: "限定的群", note: config.allowedChatIds.length ? `${config.allowedChatIds.length} 个` : "不限", value: "chats" },
        { label: "Claude 调用方式", note: config.authMode === "api_key" ? "API key" : "订阅登录", value: "auth" },
        { label: "机器人应用和主人", note: "重新运行配置向导，每一步都可以保留原值", value: "init" },
        { label: "诊断", note: "逐项检查哪里不对", value: "doctor" },
      ],
      "退出",
    );
    if (!item) return false;
    if (item === "run") {
      if (await runMenu()) return true;
    } else if (item === "projects") await projectsMenu();
    else if (item === "level") await levelMenu(config);
    else if (item === "settings") await settingsMenu(config);
    else if (item === "allow") await allowMenu(config);
    else if (item === "chats") await chatsMenu();
    else if (item === "auth") await authMenu(config);
    else if (item === "init") {
      await (await import("./init.js")).runInit();
      await noteRestart(true);
    } else await (await import("./doctor.js")).runDoctor();
  }
}
