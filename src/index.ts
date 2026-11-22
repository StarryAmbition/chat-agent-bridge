// 入口：接收 Lark 事件，检查权限后分发给命令或任务。

import { existsSync, readFileSync, rmSync, watchFile } from "node:fs";
import { agentOf } from "./agents/index.js";
import { type Member } from "./allowlist.js";
import { approvals, resolveApproval } from "./approvals.js";
import { CardActionEvent, handleCardAction, handleCommand } from "./commands.js";
import { ALLOWED_CHAT_IDS, dataFile, AUTH_MODE, OWNER_OPEN_ID, RESTART_MARKER, SUPERVISED } from "./config.js";
import { commandWaitSeconds, shouldHandleGroupMessage } from "./gating.js";
import { hostCard } from "./host.js";
import { buildContent } from "./incoming.js";
import { submit } from "./jobs.js";
import { describeError, patchCard, Reply, reply, send } from "./chat.js";
import { platform, type ChatMessage } from "./platforms/index.js";
import { NOTIFY_AFTER_OFFLINE_MS, OutageTracker } from "./connection.js";
import { formatDuration } from "./tools.js";
import { housekeeping, restart } from "./service.js";
import { reloadSettings, settings, SETTINGS_FILE } from "./settings.js";
import { allowlist, canCommand, MEMBERS_NEED_API_KEY, roleOf, store } from "./state.js";
import { usageOrError } from "./usage.js";
import { allowCard, helpCard, refreshChatMembers, senderName } from "./views.js";
import { log, logDetail, logError, preview as logPreview, rememberName, who } from "./log.js";
import { SCHEDULE_HELP } from "./schedule.js";
import { addTask, listTasks, removeTask, scheduleCard, startScheduler } from "./scheduler.js";

// Agent SDK 每次调用都会警告一次"部分工具不经过审批回调"。这是有意的设计
// （危险操作由 PreToolUse 钩子把关），所以把这一条过滤掉，其他警告照常显示
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if ((warning as { code?: string }).code === "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED") return;
  logError(`${warning.name}`, warning.message);
});

export const seen = new Set<string>();

// ---------- 离线检测：睡眠或断网之后，告诉用户这段时间的消息没收到 ----------

const outages = new OutageTracker(Date.now());

function reportOutage(durationMs: number | undefined): void {
  if (durationMs === undefined) return;
  log("连接", `刚才离线了 ${formatDuration(durationMs)}`);
  if (durationMs < NOTIFY_AFTER_OFFLINE_MS) return;
  const text =
    `bridge 刚才离线了大约 ${formatDuration(durationMs)}（电脑睡眠或网络中断）。` +
    "这段时间里发给我的消息没有收到，需要的话请重新发一次。";
  for (const chatId of ALLOWED_CHAT_IDS) send(chatId, text).catch((err) => logError("离线提醒发送失败", describeError(err)));
}

setInterval(() => reportOutage(outages.tick(Date.now(), platform.connected())), 30_000);

/** 处理平台送来的一条消息。 */
function onMessage(message: ChatMessage): void {
    const { messageId, chatId, senderId, threadId, direct, mentionsBot, mentionedOthers } = message;
    if (message.senderName) rememberName(senderId, message.senderName);
    // 话题里的消息有自己的会话：范围写成 "群 ID#话题 ID"
    const scope = threadId ? `${chatId}#${threadId}` : chatId;

    // 平台在处理超时的时候会重推事件，按消息 ID 去重
    if (seen.has(messageId)) return;
    seen.add(messageId);
    if (seen.size > 2000) {
      // 只需要记住最近的消息；Set 按插入顺序遍历，删掉最早的一半
      for (const id of [...seen].slice(0, 1000)) seen.delete(id);
    }

    if (!OWNER_OPEN_ID) {
      log("收到", `…${senderId.slice(-6)}`, "还没有设置主人，不执行任何指令");
      logDetail("解决", "运行 chat-agent-bridge init，在第 3 步确认谁是主人");
      return;
    }

    // 只有主人和白名单里的人能指挥；其他人的消息直接忽略，不进入会话
    const role = roleOf(senderId);
    if (role === "none") return;
    if (ALLOWED_CHAT_IDS.size > 0 && !ALLOWED_CHAT_IDS.has(chatId)) return;

    // 订阅登录模式下，白名单成员的指令不执行；他们 @ 机器人时回一段说明
    if (!canCommand(role)) {
      if (mentionsBot || direct) {
        reply(messageId, MEMBERS_NEED_API_KEY).catch((err) => logError("回复出错", err));
      }
      return;
    }

    // 群里：@ 了机器人才处理；持续对话开启时，之后不带 @ 的消息也处理，直到 @ 了别人
    // 收不到非 @ 消息的平台上，送到这里的都是 @ 了机器人的，不需要这一层判断
    if (!direct && platform.features.ambient) {
      const mentionsOthers = mentionedOthers.length > 0 || message.mentionsAll;
      if (!shouldHandleGroupMessage(`${chatId}:${senderId}`, mentionsBot, mentionsOthers)) return;
    }
    const incoming = message.incoming;
    if (!incoming) {
      reply(messageId, "目前支持文字、图片、文件和富文本消息，这种类型还不支持。").catch((err) =>
        logError("回复出错", err),
      );
      return;
    }
    const hasAttachments = incoming.images.length > 0 || incoming.files.length > 0;
    const text = incoming.text;
    const attachmentNote = hasAttachments
      ? `[图片 ${incoming.images.length}，文件 ${incoming.files.length}]`
      : undefined;
    log(
      text.startsWith("/") && !hasAttachments ? "命令" : "收到",
      who(senderId),
      text ? logPreview(text) : attachmentNote ? undefined : "（只 @ 了机器人）",
      attachmentNote,
    );
    if (!text && !hasAttachments) {
      // 只 @ 了机器人、没说话：告诉对方现在在跟谁对话，并给出命令列表
      if (mentionsBot) {
        const project = store.current(scope);
        const intro =
          `你现在正在跟 ${agentOf(store.agent(scope)).name} 对话，当前项目是「${project.name}」${threadId ? "（这个话题有自己独立的会话）" : ""}。` +
          (settings.follow && platform.features.ambient ? "\n接下来的消息不用再 @ 我，直到你 @ 了别人。" : "\n每条消息都需要 @ 我。");
        reply(messageId, helpCard(`${agentOf(store.agent(scope)).name} 已就绪`, intro)).catch((err) =>
          logError("回复出错", err),
        );
      }
      return;
    }

    // 批准或拒绝正在等待的危险操作（卡片按钮的文字版）：只有主人能用
    if (text === "/approve" || text === "/deny") {
      const pending = [...approvals.values()].find((a) => a.job.chatId === chatId);
      let result: string;
      if (role !== "owner") result = "只有机器人的主人可以批准或拒绝操作。";
      else if (!pending) result = "现在没有等待批准的操作。";
      else {
        const ok = text === "/approve";
        const updated = resolveApproval(pending.id, ok);
        if (updated && pending.cardId) patchCard(pending.cardId, updated).catch(() => {});
        result = ok ? `已批准：${pending.tool}` : `已拒绝：${pending.tool}`;
      }
      reply(messageId, result).catch((err) => logError("回复出错", err));
      return;
    }

    if (text === "/restart" || text === "/restart force") {
      (role === "owner"
        ? restart(chatId, text.endsWith("force"))
        : Promise.resolve("只有机器人的主人可以重启服务。")
      )
        .then((result) => reply(messageId, result))
        .catch((err) => logError("回复出错", err));
      return;
    }

    // 白名单管理：只有主人能用。添加和移除靠消息里 @ 的人来指定
    if (text === "/allow" || text.startsWith("/allow ")) {
      if (role !== "owner") {
        reply(messageId, "只有机器人的主人可以管理白名单。").catch((err) =>
          logError("回复出错", err),
        );
        return;
      }
      const sub = text.split(/\s+/)[1] ?? "";
      let result: Reply;
      if (sub === "add" || sub === "remove") {
        if (mentionedOthers.length === 0) {
          result = `请在命令里 @ 要${sub === "add" ? "添加" : "移除"}的人，例如：@机器人 /allow ${sub} @某人`;
        } else if (sub === "add") {
          const added = mentionedOthers.filter((m) => allowlist.add(m)).map((m) => m.name);
          result = added.length ? `已加入白名单：${added.join("、")}` : "这些人已经在白名单里了。";
        } else {
          const removed = mentionedOthers
            .map((m) => allowlist.remove(m.id))
            .filter((m): m is Member => Boolean(m))
            .map((m) => m.name);
          result = removed.length ? `已移出白名单：${removed.join("、")}` : "这些人不在白名单里。";
        }
        reply(messageId, result).catch((err) => logError("回复出错", err));
        return;
      }
      refreshChatMembers(chatId)
        .then(() => reply(messageId, allowCard(chatId)))
        .catch((err) => logError("回复出错", err));
      return;
    }

    // 改设置只有主人能做
    if (role !== "owner" && /^\/settings?(\s|$)/.test(text) && text.split(/\s+/).length > 1) {
      reply(messageId, "只有机器人的主人可以修改设置。").catch((err) => logError("回复出错", err));
      return;
    }

    // 定时任务会在没人看着的时候自己执行，所以只有主人能管理
    if (text === "/schedule" || text.startsWith("/schedule ")) {
      const rest = text.slice("/schedule".length).trim();
      let result: Reply;
      if (role !== "owner") {
        result = "只有机器人的主人可以管理定时任务。";
      } else if (!rest) {
        result = scheduleCard(chatId);
      } else if (rest.startsWith("add ")) {
        result = addTask(chatId, store.current(scope).name, senderId, rest.slice(4));
      } else if (/^(remove|del|delete)\s+\d+$/.test(rest)) {
        const task = listTasks(chatId)[Number(rest.split(/\s+/)[1]) - 1];
        result = task && removeTask(task.id) ? `已删除定时任务：${task.prompt}` : "没有这个序号的定时任务。";
      } else {
        result = `用法：/schedule 查看；/schedule add <时间> <指令> 添加；/schedule remove <序号> 删除。\n${SCHEDULE_HELP}`;
      }
      reply(messageId, result).catch((err) => logError("回复出错", err));
      return;
    }

    if (text === "/host") {
      hostCard()
        .then((r) => reply(messageId, r))
        .catch((err) => logError("回复出错", err));
      return;
    }

    // 查询用量是异步的，单独处理；同样不排队、不受频率限制
    if (text === "/usage") {
      usageOrError()
        .then((r) => reply(messageId, r))
        .catch((err) => logError("回复出错", err));
      return;
    }

    const agent = agentOf(store.agent(scope));
    if (text === "/compact" && !agent.features.compact) {
      reply(messageId, `${agent.name} 不支持压缩会话，可以用 /new 开一个新会话。`).catch((err) => logError("回复出错", err));
      return;
    }

    // 斜杠命令立即处理，不排队，也不受频率限制。/compact 是发给 Claude 的，走正常的任务流程
    if (!hasAttachments && text !== "/compact") {
      const commandReply = handleCommand(scope, text);
      if (commandReply !== undefined) {
        reply(messageId, commandReply).catch((err) => logError("回复出错", err));
        return;
      }
    }

    // API key 只对 Claude 生效；其他 agent 用的是主人在本机的个人登录，只有主人能用
    if (role !== "owner" && agent.id !== "claude") {
      reply(messageId, `这个群现在用的是 ${agent.name}，它用的是主人在这台电脑上的个人登录，只有主人能指挥。`).catch((err) =>
        logError("回复出错", err),
      );
      return;
    }

    const waitSeconds = commandWaitSeconds(chatId);
    if (waitSeconds > 0) {
      log("拦截", who(senderId), `命令间隔 ${settings.intervalSeconds} 秒，还要等 ${waitSeconds} 秒`);
      reply(
        messageId,
        `已拦截：我们只允许 ${settings.intervalSeconds} 秒内一个命令，请 ${waitSeconds} 秒后再试。`,
      ).catch((err) => logError("回复出错", err));
      return;
    }

    // 立即返回，下载附件和实际执行都在后台进行，避免事件超时重推。
    // 项目在收到消息时就确定，之后再 /use 切换不会影响已提交的指令。
    const project = store.current(scope);
    const preview =
      (text.replace(/\s+/g, " ").slice(0, 60) || "") +
      (hasAttachments ? `${text ? " " : ""}[附件 ${incoming.images.length + incoming.files.length} 个]` : "");
    // 有多个账号能指挥时，在指令前标明是谁说的，Claude 才分得清
    const tagged =
      allowlist.list().length > 0 && text !== "/compact"
        ? senderName(chatId, senderId).then((name) =>
            name ? { ...incoming, text: `[${name}] ${incoming.text}`.trim() } : incoming,
          )
        : Promise.resolve(incoming);
    tagged
      .then((message) => buildContent(messageId, message))
      .then((content) => submit({ chatId, scope, project, messageId, senderId, preview, content }))
      .catch((err) => {
        logError("处理附件出错", describeError(err));
        reply(
          messageId,
          `图片或文件下载失败：${describeError(err).slice(0, 200)}\n可能是应用没有开通读取消息中资源文件的权限。`,
        ).catch(() => {});
      });
}

try {
  await platform.start({
    message: onMessage,
    cardAction: (event) => handleCardAction(event as CardActionEvent),
    connection: (state, detail) => {
      if (state === "lost") {
        outages.lost(Date.now());
        log("连接", `和 ${platform.name} 的连接断开了，正在重连`);
      } else if (state === "restored") {
        log("连接", "已重新连上");
        reportOutage(outages.restored(Date.now()));
      } else {
        // 重试用尽：退出进程。后台服务会自动把它重新拉起来，比挂着一个收不到消息的进程好
        logError(`连不上 ${platform.name}，退出`, detail);
        process.exit(1);
      }
    },
  });
} catch (err) {
  logError(`连接 ${platform.name} 失败`, err);
  process.exit(1);
}

housekeeping();
const activeTasks = startScheduler();

// 每小时检查一次：清理过期的附件，日志太大时轮转
setInterval(housekeeping, 3600_000).unref();

// 上一次是通过 /restart 重启的：回到群里说一声
if (existsSync(RESTART_MARKER)) {
  const notifyChat = readFileSync(RESTART_MARKER, "utf8").trim();
  rmSync(RESTART_MARKER, { force: true });
  if (notifyChat) send(notifyChat, "重启完成，新的代码已经生效。").catch(() => {});
}

// 先把群成员的名字读进来，日志里才能显示名字而不是一串 ID
await Promise.all([...ALLOWED_CHAT_IDS].map((id) => refreshChatMembers(id)));
if (OWNER_OPEN_ID && who(OWNER_OPEN_ID).startsWith("…")) rememberName(OWNER_OPEN_ID, "主人");

log("启动", "bridge 已启动，开始接收消息");
logDetail("项目", store.list().map((p) => p.name).join("、"));
logDetail("认证", AUTH_MODE === "api_key" ? "API key" : "订阅登录");
logDetail(
  "权限",
  OWNER_OPEN_ID
    ? `主人 ${who(OWNER_OPEN_ID)}` +
        (allowlist.list().length ? `，白名单 ${allowlist.list().map((m) => m.name).join("、")}` : "，白名单为空")
    : "还没有设置主人，不执行任何指令（运行 chat-agent-bridge init）",
);
logDetail("定时", activeTasks > 0 ? `${activeTasks} 个定时任务在排期中` : "没有定时任务");
logDetail("运行", SUPERVISED ? "后台自启服务" : "终端手动启动（Ctrl+C 停止）");
if (!SUPERVISED) logDetail("配置", "另开一个终端窗口运行 chat-agent-bridge，可以随时修改项目、权限和各项设置");

// 在终端里用 chat-agent-bridge 改了设置或白名单后，这里自动重新读取，不用重启
watchFile(SETTINGS_FILE, { interval: 2000 }, () => {
  if (reloadSettings()) log("设置", "设置文件有改动，已重新读取");
});
watchFile(dataFile("allowlist.json"), { interval: 2000 }, () => {
  if (allowlist.reload()) {
    log("白名单", allowlist.list().length ? `已重新读取：${allowlist.list().map((m) => m.name).join("、")}` : "已重新读取：现在为空");
  }
});
