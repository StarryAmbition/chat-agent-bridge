// 斜杠命令和卡片按钮点击的处理。

import { agentOf, findAgent } from "./agents/index.js";
import { resolveApproval } from "./approvals.js";
import { CardAction, isOwnerOnly } from "./cards.js";
import { ALLOWED_CHAT_IDS } from "./config.js";
import { hostCard } from "./host.js";
import { laneKey, stopLane, submit } from "./jobs.js";
import { Reply, send } from "./chat.js";
import { MAX_IDLE_MINUTES, MAX_INTERVAL_SECONDS, MODEL_PATTERN, setApprove, setFollow, setFollowIdle, setCodexModel, setIntervalSeconds, setModel } from "./settings.js";
import { allowlist, canCommand, MEMBERS_NEED_API_KEY, roleOf, store } from "./state.js";
import { usageOrError } from "./usage.js";
import { aboutCard, agentCard, allowCard, helpCard, historyCard, modelCard, projectsCard, refreshChatMembers, settingsCard, statusCard } from "./views.js";
import { log, logError, who } from "./log.js";
import { removeTask, runTaskNow, scheduleCard, toggleTask } from "./scheduler.js";

export function switchProject(chatId: string, target: string): { ok: boolean; message: string } {
  const result = store.use(chatId, target);
  if (typeof result === "string") return { ok: false, message: result };
  const resumed = store.getSession(chatId, result) ? "续用之前的会话" : "新会话";
  return { ok: true, message: `已切换到「${result.name}」（${resumed}）` };
}

export function resumeSession(scope: string, target: string): { ok: boolean; message: string } {
  const project = store.current(scope);
  const record = store.resume(scope, project, target);
  return record
    ? { ok: true, message: `已切回会话：${record.title || record.id.slice(0, 8)}` }
    : { ok: false, message: "没有找到这个会话。发 /history 查看列表。" };
}

/** 切换这个范围用的 agent。 */
export function switchAgent(scope: string, target: string): { ok: boolean; message: string } {
  const agent = findAgent(target);
  if (!agent) return { ok: false, message: `没有叫「${target}」的 agent。发 /agent 查看可以选哪些。` };
  store.setAgent(scope, agent.id);
  const resumed = store.getSession(scope, store.current(scope)) ? "续用它之前的会话" : "新会话";
  return {
    ok: true,
    message:
      `已切换到 ${agent.name}（${resumed}）。` +
      (agent.features.approvals ? "" : `\n注意：${agent.name} ${agent.note}。`),
  };
}

export function newSession(chatId: string): string {
  const current = store.current(chatId);
  store.clearSession(chatId, current);
  return `已在「${current.name}」开启新会话。`;
}

const VIEW_NAMES: Record<string, string> = {
  use: "项目",
  setting: "设置",
  help: "命令列表",
  usage: "用量",
  allow: "白名单",
  status: "状态",
  about: "功能介绍",
  history: "历史会话",
  schedule: "定时任务",
  host: "宿主机",
  model: "模型",
  agent: "切换 agent",
};

/** 把一次按钮点击写成一句话，用在终端日志里。 */
function describeAction(action: CardAction): string {
  switch (action.a) {
    case "show":
      return `打开「${VIEW_NAMES[action.view] ?? action.view}」`;
    case "use":
      return `切换到项目 ${action.project}`;
    case "new":
      return "开启新会话";
    case "follow":
      return `持续对话：${action.on ? "开" : "关"}`;
    case "approval":
      return `危险操作审批：${action.on ? "开" : "关"}`;
    case "interval":
      return `命令间隔：${action.seconds === 0 ? "不限制" : `${action.seconds} 秒`}`;
    case "idle":
      return `空闲自动结束：${action.minutes === 0 ? "不结束" : `${action.minutes} 分钟`}`;
    case "model":
      return `模型：${action.model || "默认"}`;
    case "agent":
      return `切换 agent：${action.agent}`;
    case "decide":
      return action.ok ? "批准操作" : "拒绝操作";
    case "stop":
      return "停止任务";
    case "compact":
      return "压缩会话";
    case "allow_add":
      return `白名单添加 ${action.name}`;
    case "allow_remove":
      return `白名单移除 ${who(action.id)}`;
    case "resume":
      return "切回历史会话";
    case "sched_del":
      return "删除定时任务";
    case "sched_toggle":
      return "暂停或恢复定时任务";
    case "sched_run":
      return "立即执行定时任务";
  }
}

/** 执行一次按钮点击，返回提示文字和更新后的卡片。 */
export function applyCardAction(chatId: string, action: CardAction): { ok: boolean; toast: string; card: object } {
  switch (action.a) {
    case "use": {
      const r = switchProject(chatId, action.project);
      return { ok: r.ok, toast: r.message, card: projectsCard(chatId).card };
    }
    case "new":
      return { ok: true, toast: newSession(chatId), card: projectsCard(chatId).card };
    case "follow":
      return { ok: true, toast: setFollow(action.on), card: settingsCard().card };
    case "interval": {
      const n = action.seconds;
      if (!Number.isInteger(n) || n < 0 || n > MAX_INTERVAL_SECONDS) {
        return { ok: false, toast: "间隔数值不合法。", card: settingsCard().card };
      }
      return { ok: true, toast: setIntervalSeconds(n), card: settingsCard().card };
    }
    case "approval":
      return { ok: true, toast: setApprove(action.on), card: settingsCard().card };
    case "idle": {
      const n = action.minutes;
      if (!Number.isInteger(n) || n < 0 || n > MAX_IDLE_MINUTES) {
        return { ok: false, toast: "分钟数不合法。", card: settingsCard().card };
      }
      return { ok: true, toast: setFollowIdle(n), card: settingsCard().card };
    }
    case "model": {
      if (typeof action.model !== "string" || !MODEL_PATTERN.test(action.model)) {
        return { ok: false, toast: "模型名不合法。", card: modelCard(chatId).card };
      }
      return { ok: true, toast: setModel(action.model), card: modelCard(chatId).card };
    }
    case "agent": {
      const r = switchAgent(chatId, String(action.agent));
      return { ok: r.ok, toast: r.message.split("\n")[0], card: agentCard(chatId).card };
    }
    case "stop": {
      const message = stopLane(action.key);
      return { ok: true, toast: message, card: statusCard(chatId).card };
    }
    case "resume": {
      const r = resumeSession(chatId, action.id);
      return { ok: r.ok, toast: r.message, card: historyCard(chatId).card };
    }
    case "sched_del": {
      const task = removeTask(action.id);
      return { ok: Boolean(task), toast: task ? "已删除这个定时任务。" : "这个任务已经不存在了。", card: scheduleCard(chatId).card };
    }
    case "sched_toggle": {
      const task = toggleTask(action.id);
      return {
        ok: Boolean(task),
        toast: task ? (task.enabled ? "已恢复。" : "已暂停。") : "这个任务已经不存在了。",
        card: scheduleCard(chatId).card,
      };
    }
    case "sched_run": {
      const task = runTaskNow(action.id);
      return { ok: Boolean(task), toast: task ? "已开始执行。" : "这个任务已经不存在了。", card: scheduleCard(chatId).card };
    }
    case "decide":
    case "compact":
      // 这两个动作由 handleCardAction 单独处理，不会走到这里
      return { ok: false, toast: "", card: statusCard(chatId).card };
    case "allow_add": {
      const added = allowlist.add({ id: action.id, name: action.name });
      return {
        ok: added,
        toast: added ? `已把 ${action.name} 加入白名单。` : `${action.name} 已经在白名单里了。`,
        card: allowCard(chatId).card,
      };
    }
    case "allow_remove": {
      const removed = allowlist.remove(action.id);
      return {
        ok: Boolean(removed),
        toast: removed ? `已把 ${removed.name} 移出白名单。` : "这个人不在白名单里。",
        card: allowCard(chatId).card,
      };
    }
    case "show": {
      // "usage"、"allow"、"host" 需要异步查询，由 handleCardAction 单独处理，不会走到这里
      const view =
        action.view === "use"
          ? projectsCard(chatId)
          : action.view === "setting"
            ? settingsCard()
            : action.view === "status"
              ? statusCard(chatId)
              : action.view === "history"
                ? historyCard(chatId)
                : action.view === "schedule"
                  ? scheduleCard(chatId)
                  : action.view === "about"
                ? aboutCard()
                : action.view === "model"
                  ? modelCard(chatId)
                  : action.view === "agent"
                    ? agentCard(chatId)
                    : helpCard();
      return { ok: true, toast: "", card: view.card };
    }
  }
}

/** 是斜杠命令时返回回复；不是命令时返回 undefined，交给 Claude 处理。 */
export function handleCommand(chatId: string, text: string): Reply | undefined {
  if (!text.startsWith("/")) return undefined;
  const [command, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");

  switch (command) {
    case "/help":
      return helpCard();
    case "/use":
      return arg ? switchProject(chatId, arg).message : projectsCard(chatId);
    case "/new":
      return newSession(chatId);
    case "/about":
      return aboutCard();
    case "/model": {
      if (!arg) return modelCard(chatId);
      const model = ["default", "默认"].includes(arg.toLowerCase()) ? "" : arg;
      if (!MODEL_PATTERN.test(model)) return "模型名只能包含字母、数字和 . _ - 这些符号。";
      // 模型是按 agent 分开设置的：改的是这个群当前所用 agent 的模型
      return store.agent(chatId) === "codex" ? setCodexModel(model) : setModel(model);
    }
    case "/agent":
      return arg ? switchAgent(chatId, arg).message : agentCard(chatId);
    case "/status":
      return statusCard(chatId);
    case "/history": {
      if (!arg) return historyCard(chatId);
      return resumeSession(chatId, arg).message;
    }
    case "/stop":
      return stopLane(laneKey(chatId, store.current(chatId)));
    case "/setting":
    case "/settings": {
      if (!arg) return settingsCard();
      const [key, value, ...extra] = rest;
      if (key === "follow") {
        const on = ["on", "开", "true", "1"].includes(value ?? "");
        const off = ["off", "关", "false", "0"].includes(value ?? "");
        if (extra.length > 0 || (!on && !off)) return "写成 /setting follow on 或 /setting follow off。";
        return setFollow(on);
      }
      if (key === "approve") {
        const on = ["on", "开", "true", "1"].includes(value ?? "");
        const off = ["off", "关", "false", "0"].includes(value ?? "");
        if (extra.length > 0 || (!on && !off)) return "写成 /setting approve on 或 /setting approve off。";
        return setApprove(on);
      }
      if (key === "idle") {
        const minutes = extra.length === 0 && /^\d+$/.test(value ?? "") ? Number(value) : NaN;
        if (!Number.isInteger(minutes) || minutes > MAX_IDLE_MINUTES) {
          return `写成 /setting idle <分钟>，0 到 ${MAX_IDLE_MINUTES} 之间，0 为不自动结束。`;
        }
        return setFollowIdle(minutes);
      }
      if (key !== "interval") {
        return `没有叫「${key}」的设置。可设置的有 interval、follow、idle 和 approve。`;
      }
      // 允许写成 30、30s、30秒
      const match = extra.length === 0 ? /^(\d+)(s|秒)?$/.exec(value ?? "") : null;
      const seconds = match ? Number(match[1]) : NaN;
      if (!Number.isInteger(seconds) || seconds > MAX_INTERVAL_SECONDS) {
        return `间隔要写成 0 到 ${MAX_INTERVAL_SECONDS} 之间的整数秒，例如 /setting interval 30。`;
      }
      return setIntervalSeconds(seconds);
    }
    default:
      return helpCard(`不认识的命令 ${command}，可用命令如下`);
  }
}

/** 卡片按钮点击事件里我们用到的字段。 */
export interface CardActionEvent {
  operator?: { open_id?: string };
  action?: { value?: unknown };
  context?: { open_chat_id?: string; open_message_id?: string };
}

export function toast(type: "success" | "error" | "info", content: string): object {
  return { toast: { type, content } };
}

/** 处理卡片按钮点击。必须在 3 秒内返回；返回值会让 Lark 弹出提示并原地更新卡片。 */
export function handleCardAction(data: CardActionEvent): object {
  const operatorId = data.operator?.open_id ?? "";
  const chatId = data.context?.open_chat_id ?? "";
  // 群里任何人都能点按钮，所以这里和发消息一样要检查身份
  const role = roleOf(operatorId);
  if (role === "none") return toast("error", "你不在允许对话的名单里。");
  if (!canCommand(role)) return toast("error", MEMBERS_NEED_API_KEY);
  if (!chatId || (ALLOWED_CHAT_IDS.size > 0 && !ALLOWED_CHAT_IDS.has(chatId))) {
    return toast("error", "这个群不在允许的列表里。");
  }
  const action = data.action?.value as CardAction | undefined;
  if (!action || typeof action !== "object" || typeof action.a !== "string") {
    return toast("error", "无法识别的按钮。");
  }
  if (role !== "owner" && isOwnerOnly(action)) {
    return toast("error", "只有机器人的主人可以改设置和管理白名单。");
  }
  log("按钮", who(operatorId), describeAction(action));
  if (action.a === "show" && action.view === "allow") {
    // 要先读群成员，可能超过回调的 3 秒限制：查到后作为新消息发到群里
    refreshChatMembers(chatId)
      .then(() => send(chatId, allowCard(chatId)))
      .catch((err) => logError("发送白名单出错", err));
    return toast("info", "正在读取名单…");
  }
  if (action.a === "show" && action.view === "host") {
    hostCard()
      .then((r) => send(chatId, r))
      .catch((err) => logError("发送宿主机状态出错", err));
    return toast("info", "正在读取宿主机状态…");
  }
  if (action.a === "show" && action.view === "usage") {
    // 查询用量要一两秒，可能超过回调的 3 秒限制：先提示，查到后作为新消息发到群里
    usageOrError()
      .then((r) => send(chatId, r))
      .catch((err) => logError("发送用量出错", err));
    return toast("info", "正在查询用量…");
  }
  if (action.a === "decide") {
    const updated = resolveApproval(action.id, action.ok);
    if (!updated) return toast("error", "这个审批已经处理过，或者已经失效。");
    return {
      ...toast(action.ok ? "success" : "info", action.ok ? "已批准" : "已拒绝"),
      card: { type: "raw", data: updated },
    };
  }
  if (action.a === "compact") {
    const agent = agentOf(store.agent(chatId));
    if (!agent.features.compact) return toast("error", `${agent.name} 不支持压缩会话，可以用 /new 开一个新会话。`);
    const cardMessageId = data.context?.open_message_id;
    if (!cardMessageId) return toast("error", "找不到这张卡片对应的消息。");
    submit({
      chatId,
      scope: chatId,
      project: store.current(chatId),
      messageId: cardMessageId,
      senderId: operatorId,
      preview: "压缩会话",
      content: "/compact",
    });
    return toast("info", "已开始压缩会话。");
  }
  const result = applyCardAction(chatId, action);
  return {
    ...(result.toast ? toast(result.ok ? "success" : "error", result.toast) : {}),
    card: { type: "raw", data: result.card },
  };
}
