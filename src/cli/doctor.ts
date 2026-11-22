// 诊断：把配置过程中常见的问题逐项自动检查，并给出修复办法。

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { sleepDisabled } from "./awake.js";
import { claudeAccount } from "./claude.js";
import { CONSOLE_URL, describeLarkError, fetchBot, makeClient, verifyCredentials } from "./larkSetup.js";
import { foregroundInstances, serviceState } from "./serviceCmd.js";
import { configPath, dataDir, loadConfig, loadProjects } from "./store.js";
import { bold, dim, fail, hint, ok, say, warn } from "./ui.js";

type Level = "ok" | "warn" | "fail";

interface Finding {
  level: Level;
  text: string;
  fixes?: string[];
}

function report(f: Finding): void {
  (f.level === "ok" ? ok : f.level === "warn" ? warn : fail)(f.text);
  for (const fix of f.fixes ?? []) hint(fix);
}

/** 其他可能在用同一个机器人的程序 */
function competingPrograms(): string[] {
  try {
    const out = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
    return out
      .split("\n")
      .filter((l) => /lark-channel-bridge|feishu-bot|lark-bot/.test(l) && !/lark-claude-bridge|chat-agent-bridge/.test(l))
      .map((l) => l.trim().slice(0, 110));
  } catch {
    return [];
  }
}

export async function runDoctor(): Promise<void> {
  say(bold("\nChat Agent Bridge 诊断\n"));
  const findings: Finding[] = [];
  const add = (f: Finding): void => {
    findings.push(f);
    report(f);
  };

  // 运行环境
  const major = Number(process.versions.node.split(".")[0]);
  add(
    major >= 20
      ? { level: "ok", text: `Node.js ${process.versions.node}` }
      : { level: "fail", text: `Node.js ${process.versions.node} 太旧`, fixes: ["需要 20 或更高版本。"] },
  );

  // 配置
  const config = loadConfig();
  if (!config) {
    add({ level: "fail", text: `还没有配置（${configPath()} 不存在或不完整）`, fixes: ["运行 chat-agent-bridge init。"] });
    summary(findings);
    return;
  }
  add({ level: "ok", text: `配置文件 ${configPath()}` });
  try {
    accessSync(dataDir(), constants.W_OK);
  } catch {
    add({ level: "fail", text: `数据目录 ${dataDir()} 不可写` });
  }

  // Claude
  say(dim("\n检查 Claude Code…"));
  const account = await claudeAccount(config.authMode === "api_key" ? config.apiKey : undefined);
  if (account.loggedIn) {
    add({
      level: "ok",
      text:
        config.authMode === "api_key"
          ? "Claude：API key 可用"
          : `Claude Code 已登录${account.subscription ? `（${account.subscription} 订阅）` : ""}`,
    });
  } else {
    add({
      level: "fail",
      text: config.authMode === "api_key" ? "Claude：API key 无法使用" : "Claude Code 没有登录",
      fixes: [
        config.authMode === "api_key"
          ? "重新运行 chat-agent-bridge init 填入有效的 key。"
          : "重新运行 chat-agent-bridge init，在第一步选择登录。",
        ...(account.error ? [`详细信息：${account.error}`] : []),
      ],
    });
  }

  // Lark 凭证
  say(dim("\n检查 Lark / 飞书应用…"));
  const check = await verifyCredentials(config.appId, config.appSecret, config.domain);
  if ("error" in check) {
    add({
      level: "fail",
      text: `应用凭证无效：${check.error}`,
      fixes: ["App Secret 可能被重置过，或者应用被停用了。重新运行 chat-agent-bridge init。"],
    });
  } else {
    if (check.domain !== config.domain) {
      add({
        level: "fail",
        text: `域名配错了：这个应用属于${check.domain === "lark" ? " Lark 国际版" : "飞书国内版"}`,
        fixes: [`把 ${configPath()} 里的 domain 改成 "${check.domain}"，或者重新运行 init。`],
      });
    } else {
      add({ level: "ok", text: `应用凭证有效，机器人「${check.bot.name}」（${check.domain === "lark" ? "Lark 国际版" : "飞书"}）` });
    }
    const client = makeClient(config.appId, config.appSecret, check.domain);

    // 主人和群
    if (!config.ownerOpenId) {
      add({ level: "fail", text: "还没有设置主人，bridge 不会执行任何指令", fixes: ["运行 chat-agent-bridge init 完成第 3 步。"] });
    } else {
      add({ level: "ok", text: "已设置主人" });
    }
    for (const chatId of config.allowedChatIds) {
      try {
        const chat = await client.im.chat.get({ path: { chat_id: chatId } });
        add({ level: "ok", text: `机器人在群「${chat.data?.name ?? chatId}」里` });
      } catch (err) {
        add({
          level: "fail",
          text: `读不到群 ${chatId}：${describeLarkError(err)}`,
          fixes: ["机器人可能被移出了群，或者应用缺少 im:chat:readonly 权限。"],
        });
      }
    }
    if (config.allowedChatIds.length === 0) {
      add({ level: "warn", text: "没有限定群，机器人在任何群里都会响应主人", fixes: ["建议重新运行 init 限定到一个群。"] });
    }

    // 权限：用实际调用来探测
    try {
      await fetchBot(config.appId, config.appSecret, check.domain);
      await client.im.chat.list({ params: { page_size: 1 } });
    } catch (err) {
      add({
        level: "warn",
        text: `读取群列表失败：${describeLarkError(err)}`,
        fixes: [`在开发者后台检查权限是否都已开通并发布：${CONSOLE_URL[check.domain]}`],
      });
    }
    add({
      level: "warn",
      text: "事件和回调的订阅情况无法自动检查",
      fixes: [
        "如果机器人完全不回消息：检查「事件与回调」里是否用长连接订阅了 im.message.receive_v1。",
        "如果卡片上的按钮点了没反应：检查「回调配置」里是否订阅了 card.action.trigger。",
        "改完都要创建新版本并发布才生效。",
      ],
    });
  }

  // 项目
  say(dim("\n检查本机…"));
  const projects = Object.entries(loadProjects());
  if (projects.length === 0) {
    add({ level: "fail", text: "没有配置项目目录", fixes: ["运行 chat-agent-bridge init 完成第 4 步。"] });
  }
  for (const [name, dir] of projects) {
    add(
      existsSync(dir)
        ? { level: "ok", text: `项目 ${name}：${dir}` }
        : { level: "fail", text: `项目 ${name} 的目录不存在：${dir}`, fixes: [`修改 ${dataDir()}/projects.json。`] },
    );
  }
  add({
    level: "ok",
    text: `权限档位：${config.allowedTools.includes("Bash") ? "可以改文件并运行命令" : config.allowedTools.includes("Edit") ? "可以改文件" : "只读"}`,
  });

  // 运行状态和冲突
  const service = serviceState();
  const foreground = foregroundInstances(service.pid);
  if (service.running && foreground.length) {
    add({
      level: "fail",
      text: `后台服务和前台各有一个 bridge 在运行（前台进程 ${foreground.join("、")}）`,
      fixes: ["两个会抢消息，表现为机器人时灵时不灵。停掉其中一个。"],
    });
  } else if (service.running) {
    add({ level: "ok", text: `后台服务正在运行（进程 ${service.pid ?? "?"}）` });
  } else if (foreground.length) {
    add({ level: "ok", text: `bridge 正在前台运行（进程 ${foreground.join("、")}）` });
  } else {
    add({
      level: "warn",
      text: "bridge 现在没有在运行",
      fixes: ["启动：chat-agent-bridge start；或装成后台服务：chat-agent-bridge service install。"],
    });
  }
  const competing = competingPrograms();
  if (competing.length) {
    add({
      level: "fail",
      text: "发现其他可能在用同一个机器人的程序",
      fixes: [...competing, "同一个应用只会把每条消息发给其中一个程序，需要停掉多余的。"],
    });
  }
  if (process.platform === "darwin" && service.installed) {
    add(
      sleepDisabled()
        ? { level: "ok", text: "系统睡眠已关闭：合上盖子也会继续运行" }
        : { level: "warn", text: "合上 MacBook 的盖子后 bridge 会停止响应", fixes: ["办法见：chat-agent-bridge awake"] },
    );
  }

  summary(findings);
}

function summary(findings: Finding[]): void {
  const fails = findings.filter((f) => f.level === "fail").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  say("");
  if (fails) fail(bold(`有 ${fails} 个问题需要处理${warns ? `，另有 ${warns} 项提醒` : ""}。`));
  else if (warns) warn(bold(`没有发现阻碍运行的问题，有 ${warns} 项提醒。`));
  else ok(bold("一切正常。"));
  process.exitCode = fails ? 1 : 0;
}
