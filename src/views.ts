// 各个界面的卡片：项目、设置、模型、白名单、状态、命令列表、功能介绍。

import { type Member } from "./allowlist.js";
import { formatDuration } from "./tools.js";
import { approvals } from "./approvals.js";
import { button, card, NAV, row } from "./cards.js";
import { AUTH_MODE, OWNER_OPEN_ID } from "./config.js";
import { allAgents, agentOf } from "./agents/index.js";
import { contextKey, contextUsage, laneKey, lanes } from "./jobs.js";
import { CardReply, describeError, members } from "./chat.js";
import { describeIdle, describeInterval, describeModel, settings } from "./settings.js";
import { allowlist, store } from "./state.js";
import { logError, rememberName } from "./log.js";
import { parentScope } from "./projects.js";

export function projectsCard(chatId: string): CardReply {
  const current = store.current(chatId);
  const projects = store.list();
  return {
    card: card("可切换的项目", [
      ...projects.map((p, i) => {
        const isCurrent = p.name === current.name;
        return row(
          `**${i + 1}. ${p.name}**${isCurrent ? "　✅ 当前" : ""}\n<font color='grey'>${p.cwd}</font>`,
          [button(isCurrent ? "使用中" : "切换", { a: "use", project: p.name }, { primary: !isCurrent, disabled: isCurrent })],
        );
      }),
      { tag: "hr" },
      row(`在「${current.name}」里重新开始`, [button("开启新会话", { a: "new" }), NAV.setting]),
    ]),
    fallback: [
      "可切换的项目（▶ 为当前）：",
      ...projects.map((p, i) => `${p.name === current.name ? "▶" : "  "} ${i + 1}. ${p.name}  ${p.cwd}`),
      "发 /use <序号或名称> 切换。",
    ].join("\n"),
  };
}

export const INTERVAL_CHOICES = [0, 10, 30, 60];

export const IDLE_CHOICES = [5, 10, 30, 0];

export const MODEL_CHOICES: [string, string, string][] = [
  ["", "默认", "Claude Code 自己选择的模型"],
  ["opus", "Opus", "能力强，消耗额度多"],
  ["sonnet", "Sonnet", "均衡，适合日常任务"],
  ["haiku", "Haiku", "最快最省，适合简单问题"],
];

/** 选择由哪个 agent 来执行。每个群（或话题）各选各的。 */
export function agentCard(scope: string): CardReply {
  const current = agentOf(store.agent(scope));
  return {
    card: card("切换 agent", [
      {
        tag: "markdown",
        content:
          `**现在用的是**：${current.name}\n` +
          "<font color='grey'>只对这个群（或话题）生效。每个 agent 有自己独立的会话，切换后再切回来，原来的会话还在。</font>",
      },
      { tag: "hr" },
      ...allAgents().map((a) =>
        row(`**${a.name}**\n<font color='grey'>${a.note}</font>`, [
          button(a.id === current.id ? "使用中" : "使用", { a: "agent", agent: a.id }, {
            primary: a.id !== current.id,
            disabled: a.id === current.id,
          }),
        ]),
      ),
      { tag: "hr" },
      row("", [NAV.model, NAV.status, NAV.help]),
    ]),
    fallback: `现在用的是 ${current.name}。切换：/agent ${allAgents().map((a) => a.id).join(" | ")}`,
  };
}

/** 模型是按 agent 分开设置的，显示的是这个范围当前所用 agent 的模型。 */
export function modelCard(scope: string): CardReply {
  const agent = agentOf(store.agent(scope));
  if (agent.id !== "claude") {
    const now = agent.model() || "默认";
    return {
      card: card(`模型 · ${agent.name}`, [
        {
          tag: "markdown",
          content:
            `**当前模型**：${now}\n` +
            `<font color='grey'>默认表示用 ${agent.name} 自己配置里的模型。要换的话发：</font>\`/model <模型名>\`<font color='grey'>，恢复默认发：</font>\`/model default\``,
        },
        { tag: "hr" },
        row("", [NAV.agent, NAV.setting, NAV.help]),
      ]),
      fallback: `${agent.name} 当前模型：${now}。修改：/model <模型名> | default`,
    };
  }
  return {
    card: card("模型 · Claude Code", [
      {
        tag: "markdown",
        content: `**当前模型**：${describeModel()}\n<font color='grey'>对所有项目生效，下一条指令开始使用。其他模型发：</font>\`/model <模型名>\``,
      },
      { tag: "hr" },
      ...MODEL_CHOICES.map(([id, label, note]) =>
        row(`**${label}**\n<font color='grey'>${note}</font>`, [
          button(settings.model === id ? "使用中" : "使用", { a: "model", model: id }, {
            primary: settings.model !== id,
            disabled: settings.model === id,
          }),
        ]),
      ),
      { tag: "hr" },
      row("", [NAV.usage, NAV.agent, NAV.setting, NAV.help]),
    ]),
    fallback: `当前模型：${describeModel()}。修改：/model opus | sonnet | haiku | default`,
  };
}

export function settingsCard(): CardReply {
  return {
    card: card("当前设置", [
      row(
        `**持续对话**：${settings.follow ? "开" : "关"}\n<font color='grey'>@ 机器人后不用每句都 @，直到 @ 了别人</font>`,
        [button(settings.follow ? "关闭" : "开启", { a: "follow", on: !settings.follow }, { primary: !settings.follow })],
      ),
      row(
        `**空闲自动结束**：${describeIdle()}\n<font color='grey'>持续对话多久没说话就自动结束</font>`,
        IDLE_CHOICES.map((n) =>
          button(n === 0 ? "不结束" : `${n} 分钟`, { a: "idle", minutes: n }, {
            primary: n === settings.followIdleMinutes,
            disabled: n === settings.followIdleMinutes,
          }),
        ),
      ),
      { tag: "hr" },
      row(
        `**命令最小间隔**：${describeInterval()}\n<font color='grey'>其他数值发：</font>\`/setting interval <秒>\``,
        INTERVAL_CHOICES.map((n) =>
          button(n === 0 ? "不限制" : `${n} 秒`, { a: "interval", seconds: n }, {
            primary: n === settings.intervalSeconds,
            disabled: n === settings.intervalSeconds,
          }),
        ),
      ),
      { tag: "hr" },
      row(
        `**危险操作审批**：${settings.approve ? "开" : "关"}\n<font color='grey'>删除、推送、安装这类操作先发卡片问你</font>`,
        [button(settings.approve ? "关闭" : "开启", { a: "approval", on: !settings.approve }, { primary: !settings.approve })],
      ),
      { tag: "hr" },
      row(`**模型**：${describeModel()}`, [NAV.model]),
      { tag: "hr" },
      row("", [NAV.allow, NAV.status, NAV.host, NAV.usage, NAV.help]),
    ]),
    fallback: [
      "当前设置：",
      `interval  命令最小间隔：${describeInterval()}（/setting interval <秒>，0 为不限制）`,
      `follow    持续对话：${settings.follow ? "开" : "关"}（/setting follow on 或 off）`,
      `approve   危险操作审批：${settings.approve ? "开" : "关"}（/setting approve on 或 off）`,
      `idle      持续对话空闲自动结束：${describeIdle()}（/setting idle <分钟>，0 为不结束）`,
      `model     模型：${describeModel()}（/model <模型名>）`,
    ].join("\n"),
  };
}

/** 各群的成员列表缓存，用来在白名单卡片里列出"可以添加的人"。 */
export const chatMembers = new Map<string, Member[]>();

export async function refreshChatMembers(chatId: string): Promise<void> {
  try {
    chatMembers.set(chatId, await members(chatId));
    for (const m of chatMembers.get(chatId) ?? []) rememberName(m.id, m.name);
  } catch (err) {
    logError("读取群成员失败", describeError(err));
  }
}

export function allowCard(chatId: string): CardReply {
  const members = chatMembers.get(chatId) ?? [];
  const ownerName = members.find((m) => m.id === OWNER_OPEN_ID)?.name ?? "主人";
  const allowed = allowlist.list();
  const candidates = members.filter((m) => m.id !== OWNER_OPEN_ID && !allowlist.has(m.id));
  const modeNote =
    AUTH_MODE === "api_key"
      ? "当前是 API key 模式：名单里的人可以直接跟 Claude Code 对话。"
      : "当前是订阅登录模式：订阅只限主人本人使用，名单里的其他人暂时不会被执行。切换到 API key 模式后生效。";
  return {
    card: card("允许跟 Claude Code 对话的人", [
      { tag: "markdown", content: `<font color='grey'>${modeNote}</font>` },
      { tag: "hr" },
      row(`**${ownerName}**　主人`, [button("不可移除", { a: "show", view: "allow" }, { disabled: true })]),
      ...allowed.map((m) => row(`**${m.name}**`, [button("删除", { a: "allow_remove", id: m.id }, { danger: true })])),
      ...(candidates.length
        ? [
            { tag: "hr" },
            { tag: "markdown", content: "**群里还可以添加的人**" },
            ...candidates.map((m) =>
              row(m.name, [button("添加", { a: "allow_add", id: m.id, name: m.name }, { primary: true })]),
            ),
          ]
        : []),
      { tag: "hr" },
      row("", [NAV.setting, NAV.help]),
    ]),
    fallback: [
      "允许跟 Claude Code 对话的人：",
      `- ${ownerName}（主人）`,
      ...allowed.map((m) => `- ${m.name}`),
      modeNote,
      "添加：@机器人 /allow add @某人；移除：@机器人 /allow remove @某人",
    ].join("\n"),
  };
}

export function statusCard(scope: string): CardReply {
  // 在群里看的是整个群（包括各个话题）的任务；会话上下文看的是当前这个范围
  const chatId = parentScope(scope);
  const current = store.current(scope);
  const elements: object[] = [];
  const lines: string[] = [];
  const mine = [...lanes.entries()].filter(
    ([key, lane]) => (key.startsWith(`${chatId}::`) || key.startsWith(`${chatId}#`)) && (lane.running || lane.pending.length > 0),
  );
  if (mine.length === 0) {
    elements.push({ tag: "markdown", content: "现在没有任务在执行。" });
    lines.push("现在没有任务在执行。");
  }
  for (const [key, lane] of mine) {
    const job = lane.running;
    const name = key.slice(key.indexOf("::") + 2) + (key.startsWith(`${chatId}#`) ? "（话题）" : "");
    const text = job
      ? `**${name}**　执行中，已用时 ${formatDuration(Date.now() - job.startedAt)}，${job.steps.length} 步` +
        (lane.pending.length ? `，另有 ${lane.pending.length} 条排队` : "") +
        `\n<font color='grey'>${job.preview}</font>` +
        (job.steps.length ? `\n<font color='grey'>最近：${job.steps[job.steps.length - 1]}</font>` : "")
      : `**${name}**　${lane.pending.length} 条排队`;
    elements.push(row(text, [button("停止", { a: "stop", key }, { danger: true })]));
    lines.push(text.replace(/<[^>]+>/g, "").replace(/\*\*/g, ""));
  }
  const waiting = [...approvals.values()].filter((a) => a.job.chatId === chatId).length;
  if (waiting > 0) {
    elements.push({ tag: "markdown", content: `有 **${waiting}** 个操作在等你批准。` });
    lines.push(`有 ${waiting} 个操作在等你批准。`);
  }

  const agent = agentOf(store.agent(scope));
  const ctx = contextUsage.get(contextKey(scope, current, agent.id));
  const hasSession = Boolean(store.getSession(scope, current));
  const ctxText = !hasSession
    ? "还没有会话"
    : !ctx
      ? "暂无数据（服务重启后，要等下一次对话才有）"
      : ctx.window
        ? `约 ${Math.round((ctx.tokens / ctx.window) * 100)}%（${Math.round(ctx.tokens / 1000)}k / ${Math.round(ctx.window / 1000)}k）`
        : `约 ${Math.round(ctx.tokens / 1000)}k tokens`;
  elements.push({ tag: "hr" });
  elements.push(
    row(`**当前项目**：${current.name}　**agent**：${agent.name}\n**会话上下文**：${ctxText}`, [
      ...(agent.features.compact ? [button("压缩会话", { a: "compact" }, { disabled: !hasSession })] : []),
      NAV.agent,
    ]),
  );
  elements.push({ tag: "hr" });
  elements.push(
    row("", [button("刷新", { a: "show", view: "status" }), NAV.history, NAV.schedule, NAV.use, NAV.host]),
  );
  lines.push(`当前项目：${current.name}；agent：${agent.name}；会话上下文：${ctxText}`);
  return { card: card("状态", elements), fallback: lines.join("\n") };
}

export const COMMANDS: [string, string][] = [
  ["/use", "列出可切换的项目"],
  ["/use <序号或名称>", "切换到该项目"],
  ["/new", "在当前项目开启新会话"],
  ["/stop", "停止当前项目正在执行的任务"],
  ["/status", "查看正在执行的任务和会话上下文"],
  ["/agent", "查看和切换执行任务的 agent（Claude Code、Codex）"],
  ["/compact", "压缩当前会话，腾出上下文"],
  ["/history", "列出这个项目用过的会话，可以切回去"],
  ["/schedule", "查看和管理定时任务"],
  ["/usage", "查看订阅版本、用量和重置时间"],
  ["/model", "查看和切换使用的模型"],
  ["/host", "查看这台电脑的状态：CPU、内存、磁盘、电量"],
  ["/setting", "查看和修改设置（持续对话、命令间隔、操作审批）"],
  ["/allow", "查看和管理允许跟 Claude Code 对话的人"],
  ["/restart", "重启 bridge 服务（需要以自启方式运行）"],
  ["/about", "bridge 的介绍和全部功能"],
  ["/help", "显示这份列表"],
];

export function helpCard(title = "可用命令", intro?: string): CardReply {
  return {
    card: card(title, [
      ...(intro ? [{ tag: "markdown", content: intro }, { tag: "hr" }] : []),
      { tag: "markdown", content: COMMANDS.map(([c, d]) => `\`${c}\`　${d}`).join("\n") },
      { tag: "markdown", content: "<font color='grey'>其他内容会作为指令发给当前项目的 agent。</font>" },
      { tag: "hr" },
      row("也可以直接点：", [NAV.about, NAV.use, NAV.status, NAV.usage, NAV.setting]),
    ]),
    fallback: [...(intro ? [intro] : []), title + "：", ...COMMANDS.map(([c, d]) => `${c}  —  ${d}`)].join(
      "\n",
    ),
  };
}

export const ABOUT: [string, string[]][] = [
  [
    "这是什么",
    [
      "把这个群接到你电脑上的 Claude Code。你在群里说话，Claude Code 就在本机的项目目录里读代码、改文件、跑命令，再把结果发回群里。",
      "群里其他人都能看到过程和结果，但只有主人和白名单里的账号能指挥。",
    ],
  ],
  [
    "怎么对话",
    [
      "**@机器人 + 指令**：开始对话。只 @ 不说话会显示命令列表。",
      "**持续对话**：@ 过一次之后不用每句都 @；@ 了别人就停止，直到再次 @ 机器人。",
      "**图片和文件**：可以直接发图片（比如报错截图）或文件，Claude 会查看。",
      "**取回文件**：Claude 生成的文件（PDF、图片、表格等）会直接发到群里，可以下载。",
      "**命令间隔**：两条指令之间可以设置最小间隔，防止误触发。",
    ],
  ],
  [
    "项目与会话",
    [
      "**多个项目**：`/use` 在不同项目之间切换，每个项目有独立的会话，切回去会续上。",
      "**并行执行**：不同项目的任务可以同时跑；同一个项目内按顺序排队。",
      "**新会话与压缩**：`/new` 重新开始，`/compact` 压缩上下文。",
      "**历史会话**：`/history` 列出这个项目用过的会话，`/new` 之后还能切回去。",
      "**话题**：在群里开一个话题（回复某条消息并选择以话题形式），这个话题就是一个独立的会话，可以和群里的主会话同时进行。",
    ],
  ],
  [
    "执行过程",
    [
      "**进度卡片**：任务执行时会显示正在做什么（读了哪个文件、跑了什么命令），回复边生成边显示，结束后原地变成结果。",
      "**排队与提醒**：前面有任务时会告诉你排在第几；跑得久的任务完成后会 @ 你。",
      "**随时停止**：点进度卡片上的「停止」，或发 `/stop`。",
      "**危险操作审批**：删除文件、推送代码、安装软件这类操作会先发卡片问你，批准后才执行。也可以发 `/approve`、`/deny`。",
      "**状态**：`/status` 查看正在执行的任务、排队情况和会话上下文占用。",
      "**定时任务**：`/schedule add 每天 09:00 <指令>` 让它到点自己执行并把结果发到群里。只有主人能管理。",
    ],
  ],
  [
    "管理",
    [
      "**白名单**：`/allow` 查看、添加、删除允许对话的账号。只有主人能管理。",
      "**用量**：`/usage` 查看订阅版本、5 小时和 7 天窗口的用量及重置时间。",
      "**设置**：`/setting` 修改持续对话、命令间隔、操作审批。只有主人能修改。",
      "**模型**：`/model` 切换模型，简单问题用更省额度的。",
      "**多个 agent**：`/agent` 在 Claude Code 和 Codex 之间切换，每个群（或话题）各选各的，会话互相独立。",
      "**宿主机**：`/host` 查看这台电脑的 CPU、内存、磁盘和电量。",
      "**重启**：`/restart` 重启服务，让代码改动生效。重启前会先检查代码，有错误就不重启。",
    ],
  ],
];

export function aboutCard(): CardReply {
  return {
    card: card("关于这个 bridge", [
      ...ABOUT.flatMap(([title, items], i) => [
        ...(i > 0 ? [{ tag: "hr" }] : []),
        { tag: "markdown", content: `**${title}**\n${items.map((t) => `- ${t}`).join("\n")}` },
      ]),
      { tag: "hr" },
      row("", [NAV.help, NAV.use, NAV.status, NAV.usage, NAV.setting]),
    ]),
    fallback: ABOUT.map(
      ([title, items]) => `${title}\n${items.map((t) => `- ${t.replace(/\*\*|`/g, "")}`).join("\n")}`,
    ).join("\n\n"),
  };
}

export function historyCard(scope: string): CardReply {
  const project = store.current(scope);
  const records = store.history(scope, project);
  const currentId = store.getSession(scope, project);
  const when = (at: number): string =>
    new Date(at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return {
    card: card(`历史会话 · ${project.name}`, [
      ...(records.length === 0
        ? [{ tag: "markdown", content: "这个项目还没有会话记录。发一条指令就会开始记录。" }]
        : records.map((r, i) =>
            row(
              `**${i + 1}. ${r.title || "（没有文字）"}**\n<font color='grey'>最近使用 ${when(r.lastUsedAt)}　开始于 ${when(r.startedAt)}</font>`,
              [
                button(r.id === currentId ? "使用中" : "切换", { a: "resume", id: r.id }, {
                  primary: r.id !== currentId,
                  disabled: r.id === currentId,
                }),
              ],
            ),
          )),
      { tag: "hr" },
      row(
        currentId ? "" : "<font color='grey'>当前没有在用的会话，下一条指令会开启新会话。</font>",
        [button("开启新会话", { a: "new" }), NAV.status, NAV.use],
      ),
    ]),
    fallback: [
      `历史会话（${project.name}）：`,
      ...records.map((r, i) => `${r.id === currentId ? "▶" : "  "} ${i + 1}. ${r.title || "（没有文字）"}  ${when(r.lastUsedAt)}`),
      "发 /history <序号> 切换。",
    ].join("\n"),
  };
}

/** 这个账号在群里的名字；查不到时返回空字符串。 */
export async function senderName(chatId: string, senderId: string): Promise<string> {
  if (!chatMembers.get(chatId)?.some((m) => m.id === senderId)) await refreshChatMembers(chatId);
  return (
    chatMembers.get(chatId)?.find((m) => m.id === senderId)?.name ??
    allowlist.list().find((m) => m.id === senderId)?.name ??
    ""
  );
}
