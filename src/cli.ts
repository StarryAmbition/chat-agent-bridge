#!/usr/bin/env node
// 命令行入口。注意：bridge 本体的模块在导入时就会读取配置，
// 所以这里要先把配置写进环境变量，再用动态导入加载它们。

import { existsSync } from "node:fs";
import { applyEnv, configPath, dataDir, loadConfig, loadProjects, type BridgeConfig } from "./cli/store.js";
import { bold, command, dim, fail, hint, ok, padTo, say } from "./cli/ui.js";

const [name = "", ...args] = process.argv.slice(2);

function help(): void {
  say(bold("\nChat Agent Bridge"));
  say("在 Lark / 飞书群里指挥这台电脑上的 Claude Code 和 Codex。\n");
  say(bold("第一次使用"));
  say(`  ${bold("init")}                配置向导：登录 Claude、创建机器人、选择项目和权限`);
  say(`  ${bold("start")}               在当前终端启动（Ctrl+C 停止）`);
  say(bold("\n修改配置"));
  say(`  ${bold("（不带参数）")}        控制面板：用菜单管理下面所有内容，启动之后也能随时改`);
  say(`  ${bold("status")}              现在是否在运行，以及当前的配置概况`);
  say(`  ${bold("project")}             项目目录：project add <目录> [名字] ｜ project remove <名字>`);
  say(`  ${bold("set")}                 设置：set <项> <值>，不带参数列出所有项和当前值`);
  say(`  ${bold("allow")}               白名单：allow add <open_id> [名字] ｜ allow remove <名字>`);
  say(bold("\n长期运行"));
  say(`  ${bold("service install")}     装成后台服务：开机自启，崩溃自动恢复`);
  say(`  ${bold("service status")}      后台服务是否在运行`);
  say(`  ${bold("service logs")}        查看后台服务的日志`);
  say(`  ${bold("service restart")}     重启后台服务`);
  say(`  ${bold("service uninstall")}   停止并移除后台服务`);
  say(`  ${bold("awake")}               合上盖子也保持运行的办法`);
  say(bold("\n排查问题"));
  say(`  ${bold("doctor")}              逐项检查配置和运行环境，给出修复办法`);
  say(`  ${bold("config")}              显示当前配置（不显示密钥）`);
  say(bold("\n维护"));
  say(`  ${bold("version")}             当前版本`);
  say(`  ${bold("update")}              更新到最新版本，并重启后台服务`);
  say(`  ${bold("uninstall")}           卸载：移除后台服务，可以选择是否删除配置和数据`);
  say(bold("\n迁移"));
  say(`  ${bold("init --import <目录>")}  从原来手动配置的安装（带 .env 的目录）导入`);
  say(dim(`\n配置和数据保存在 ${dataDir()}`));
}

function showConfig(): void {
  const config = loadConfig();
  if (!config) {
    fail("还没有配置。运行 chat-agent-bridge init。");
    process.exitCode = 1;
    return;
  }
  const mask = (s: string): string => (s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-2)}` : "已设置");
  say(bold(`\n${configPath()}\n`));
  say(`  应用          ${config.appId}（${config.domain === "lark" ? "Lark 国际版" : "飞书国内版"}）`);
  say(`  App Secret    ${mask(config.appSecret)}`);
  say(`  主人          ${config.ownerOpenId || dim("未设置")}`);
  say(`  限定的群      ${config.allowedChatIds.join("、") || dim("不限")}`);
  say(`  允许的工具    ${config.allowedTools.join("、")}`);
  say(`  调用方式      ${config.authMode === "api_key" ? `API key（${mask(config.apiKey ?? "")}）` : "Claude Code 订阅登录"}`);
  const projects = Object.entries(loadProjects());
  say(`  项目          ${projects.length ? "" : dim("未设置")}`);
  for (const [n, dir] of projects) say(`                ${n}  ${dim(dir)}${existsSync(dir) ? "" : "  （目录不存在）"}`);
  hint("\n修改：直接运行 chat-agent-bridge 进入控制面板。");
}

async function start(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    fail("还没有配置。");
    say("第一次使用请先运行配置向导：");
    command("chat-agent-bridge init");
    process.exitCode = 1;
    return;
  }
  if (Object.keys(loadProjects()).length === 0) {
    fail("还没有配置项目目录。运行 chat-agent-bridge init 完成第 4 步。");
    process.exitCode = 1;
    return;
  }
  applyEnv(config);
  try {
    await import("./index.js");
  } catch (err) {
    // 启动阶段最常见的失败是连不上聊天平台（凭证失效、域名不对、没有网络）
    fail(`启动失败：${err instanceof Error ? err.message : String(err)}`);
    hint("运行 chat-agent-bridge doctor 可以逐项检查是哪里的问题。");
    process.exit(1);
  }
}

/** 需要已有配置的命令：没有配置时给出提示并返回 undefined。 */
function needConfig(): BridgeConfig | undefined {
  const config = loadConfig();
  if (!config) {
    fail("还没有配置。运行 chat-agent-bridge init。");
    process.exitCode = 1;
  }
  return config;
}

function finish(result: { ok: boolean; text: string }): boolean {
  if (result.ok) ok(result.text);
  else {
    fail(result.text);
    process.exitCode = 1;
  }
  return result.ok;
}

async function projectCommand(): Promise<void> {
  const m = await import("./cli/manage.js");
  const { noteLive } = await import("./cli/panel.js");
  const [action = "list", a, b] = args;
  if (action === "add" && a) {
    if (finish(m.addProject(a, b))) noteLive();
  } else if ((action === "remove" || action === "rm") && a) {
    if (finish(m.removeProject(a))) noteLive();
  } else if (action === "list") {
    const projects = Object.entries(loadProjects());
    if (projects.length === 0) say(dim("还没有项目。"));
    for (const [n, dir] of projects) say(`  ${n}  ${dim(dir)}${existsSync(dir) ? "" : "  （目录不存在）"}`);
    hint("\n添加：chat-agent-bridge project add <目录> [名字]    删除：chat-agent-bridge project remove <名字>");
  } else {
    say("用法：");
    command("chat-agent-bridge project add <目录> [名字]");
    command("chat-agent-bridge project remove <名字>");
    process.exitCode = 1;
  }
}

async function setCommand(): Promise<void> {
  const config = needConfig();
  if (!config) return;
  const m = await import("./cli/manage.js");
  const { noteLive, noteRestart } = await import("./cli/panel.js");
  const [key, ...rest] = args;
  const value = rest.join(" ");
  if (key === "permission") {
    if (value in m.LEVEL_NAMES) {
      finish(m.setLevel(config, value as keyof typeof m.LEVEL_NAMES));
      await noteRestart(false);
    } else {
      fail("权限档位要写 readonly、edit 或 full。");
      process.exitCode = 1;
    }
    return;
  }
  const s = await m.settingsModule(config);
  if (key && key in m.SETTING_KEYS && value) {
    if (finish(m.applySetting(s, key as keyof typeof m.SETTING_KEYS, value))) noteLive();
    return;
  }
  if (key) {
    fail(key in m.SETTING_KEYS ? "还要写上新的值。" : `没有 ${key} 这一项。`);
    process.exitCode = 1;
  }
  const now = m.describeSettings(s);
  say(bold("\n可以设置的项，以及现在的值\n"));
  for (const k of Object.keys(m.SETTING_KEYS) as (keyof typeof m.SETTING_KEYS)[]) {
    say(`  ${bold(k.padEnd(12))} ${padTo(now[k], 10)}  ${dim(m.SETTING_KEYS[k])}`);
  }
  say(`  ${bold("permission".padEnd(12))} ${padTo(m.levelOf(config.allowedTools), 10)}  ${dim("权限档位：readonly / edit / full（改完要重启）")}`);
  hint("\n例如：chat-agent-bridge set interval 30");
}

async function allowCommand(): Promise<void> {
  const config = needConfig();
  if (!config) return;
  const m = await import("./cli/manage.js");
  const { noteLive } = await import("./cli/panel.js");
  const [action = "list", a, ...rest] = args;
  if (action === "add" && a) {
    if (finish(m.allowAdd(config, a, rest.join(" ")))) noteLive();
  } else if ((action === "remove" || action === "rm") && a) {
    if (finish(m.allowRemove(config, [a, ...rest].join(" ")))) noteLive();
  } else if (action === "list") {
    const members = m.allowlistOf(config).list();
    if (members.length === 0) say(dim("白名单是空的。"));
    for (const member of members) say(`  ${member.name}  ${dim(member.id)}`);
    if (config.authMode === "subscription") hint("\n现在是订阅登录，只有主人能指挥；白名单在 API key 方式下才生效。");
  } else {
    say("用法：");
    command("chat-agent-bridge allow add <open_id> [名字]");
    command("chat-agent-bridge allow remove <名字或 open_id>");
    process.exitCode = 1;
  }
}

switch (name) {
  case "":
  case "menu": {
    // 不带参数：有配置并且在终端里就进控制面板，否则显示帮助
    if (!loadConfig() || !process.stdin.isTTY) {
      help();
      if (!loadConfig()) hint("\n还没有配置，从 chat-agent-bridge init 开始。");
      break;
    }
    const { runPanel } = await import("./cli/panel.js");
    // 面板里可能已经加载过配置，所以用一个新进程来启动，保证读到的是最新配置
    if (await runPanel()) {
      const { spawnSync } = await import("node:child_process");
      process.exitCode = spawnSync(process.execPath, [process.argv[1], "start"], { stdio: "inherit" }).status ?? 0;
    }
    break;
  }
  case "status": {
    const config = needConfig();
    if (config) {
      say(bold("\nChat Agent Bridge\n"));
      (await import("./cli/panel.js")).printStatus(config);
    }
    break;
  }
  case "version":
  case "--version":
  case "-v":
    (await import("./cli/maintain.js")).showVersion();
    break;
  case "update":
    (await import("./cli/maintain.js")).update();
    break;
  case "uninstall":
    await (await import("./cli/maintain.js")).uninstall();
    break;
  case "project":
  case "projects":
    await projectCommand();
    break;
  case "set":
    await setCommand();
    break;
  case "allow":
    await allowCommand();
    break;
  case "init": {
    const { importFrom, runInit } = await import("./cli/init.js");
    const i = args.indexOf("--import");
    if (i !== -1) {
      if (!args[i + 1]) {
        fail("--import 后面要跟目录，例如：chat-agent-bridge init --import ~/code/old-bridge");
        process.exitCode = 1;
      } else importFrom(args[i + 1]);
    } else await runInit();
    break;
  }
  case "start":
    await start();
    break;
  case "doctor":
    await (await import("./cli/doctor.js")).runDoctor();
    break;
  case "awake":
    (await import("./cli/awake.js")).runAwake();
    break;
  case "config":
    showConfig();
    break;
  case "service": {
    const s = await import("./cli/serviceCmd.js");
    const action: Record<string, () => void> = {
      install: s.serviceInstall,
      uninstall: s.serviceUninstall,
      restart: s.serviceRestart,
      status: s.serviceStatus,
      logs: s.serviceLogs,
    };
    (action[args[0] ?? ""] ?? s.serviceHelp)();
    break;
  }
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    fail(`没有 ${name} 这个命令。`);
    help();
    process.exitCode = 1;
}
