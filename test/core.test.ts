import "./env.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";

const { settings } = await import("../src/settings.ts");
const { shouldHandleGroupMessage, commandWaitSeconds } = await import("../src/gating.ts");
const { handleCommand } = await import("../src/commands.ts");
const { store, roleOf, allowlist, canCommand } = await import("../src/state.ts");
const { parseIncoming } = await import("../src/incoming.ts");
const { isOwnerOnly } = await import("../src/cards.ts");
const { addTask, listTasks, removeTask, toggleTask } = await import("../src/scheduler.ts");

// Lark 客户端等模块可能留下定时器，测试跑完后直接退出
after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref());

const isCard = (r: unknown): boolean => typeof r === "object" && r !== null && "card" in r;

test("follow mode: mention starts it, mentioning someone else ends it", () => {
  settings.follow = true;
  settings.followIdleMinutes = 10;
  const k = "c:u1";
  assert.equal(shouldHandleGroupMessage(k, false, false, 0), false, "not started");
  assert.equal(shouldHandleGroupMessage(k, true, false, 1000), true);
  assert.equal(shouldHandleGroupMessage(k, false, false, 2000), true);
  assert.equal(shouldHandleGroupMessage(k, false, true, 3000), false, "@someone else");
  assert.equal(shouldHandleGroupMessage(k, false, false, 4000), false, "ended");
  assert.equal(shouldHandleGroupMessage(k, true, true, 5000), true, "bot and others together counts as bot");
  assert.equal(shouldHandleGroupMessage("c:u2", false, false, 6000), false, "state is per sender");
});

test("follow mode ends after the idle timeout, and activity resets the clock", () => {
  settings.follow = true;
  settings.followIdleMinutes = 10;
  const k = "c:idle";
  const min = 60_000;
  assert.equal(shouldHandleGroupMessage(k, true, false, 0), true);
  assert.equal(shouldHandleGroupMessage(k, false, false, 9 * min), true);
  assert.equal(shouldHandleGroupMessage(k, false, false, 18 * min), true, "clock was reset at 9 min");
  assert.equal(shouldHandleGroupMessage(k, false, false, 29 * min), false, "11 min idle");
  assert.equal(shouldHandleGroupMessage(k, false, false, 30 * min), false, "stays ended");
  settings.followIdleMinutes = 0;
  assert.equal(shouldHandleGroupMessage(k, true, false, 0), true);
  assert.equal(shouldHandleGroupMessage(k, false, false, 999 * min), true, "0 means never");
});

test("follow off: every message needs a mention", () => {
  settings.follow = false;
  assert.equal(shouldHandleGroupMessage("c:off", true, false, 0), true);
  assert.equal(shouldHandleGroupMessage("c:off", false, false, 1), false);
  settings.follow = true;
});

test("command interval", () => {
  settings.intervalSeconds = 60;
  assert.equal(commandWaitSeconds("rate-chat"), 0);
  assert.ok(commandWaitSeconds("rate-chat") > 0, "second command inside the window waits");
  assert.equal(commandWaitSeconds("other-chat"), 0, "per chat");
  settings.intervalSeconds = 0;
  assert.equal(commandWaitSeconds("rate-chat"), 0, "0 disables the limit");
});

test("roles", () => {
  assert.equal(roleOf("ou_owner"), "owner");
  assert.equal(roleOf("ou_x"), "none");
  allowlist.add({ id: "ou_x", name: "X" });
  assert.equal(roleOf("ou_x"), "member");
  allowlist.remove("ou_x");
  // 测试环境是订阅登录模式：只有主人能指挥，白名单成员不行
  assert.equal(canCommand("owner"), true);
  assert.equal(canCommand("member"), false);
  assert.equal(canCommand("none"), false);
});

test("slash commands: plain text is not a command", () => {
  assert.equal(handleCommand("oc_chat", "帮我看看这个 bug"), undefined);
});

test("slash commands: /use lists and switches", () => {
  assert.ok(isCard(handleCommand("oc_chat", "/use")));
  assert.match(String(handleCommand("oc_chat", "/use beta")), /已切换到「beta」/);
  assert.equal(store.current("oc_chat").name, "beta");
  assert.match(String(handleCommand("oc_chat", "/use nope")), /没有叫/);
  handleCommand("oc_chat", "/use 1");
  assert.equal(store.current("oc_chat").name, "alpha");
});

test("slash commands: /setting reads and writes, with validation", () => {
  assert.ok(isCard(handleCommand("oc_chat", "/setting")));
  handleCommand("oc_chat", "/setting interval 30s");
  assert.equal(settings.intervalSeconds, 30);
  handleCommand("oc_chat", "/setting interval 99999");
  assert.equal(settings.intervalSeconds, 30, "out of range is rejected");
  handleCommand("oc_chat", "/setting follow off");
  assert.equal(settings.follow, false);
  handleCommand("oc_chat", "/setting follow on");
  handleCommand("oc_chat", "/setting idle 5");
  assert.equal(settings.followIdleMinutes, 5);
  handleCommand("oc_chat", "/setting approve off");
  assert.equal(settings.approve, false);
  handleCommand("oc_chat", "/setting approve on");
  assert.match(String(handleCommand("oc_chat", "/setting nope 1")), /没有叫/);
});

test("slash commands: /model, /new, /history, /stop, unknown", () => {
  handleCommand("oc_chat", "/model sonnet");
  assert.equal(settings.model, "sonnet");
  handleCommand("oc_chat", "/model default");
  assert.equal(settings.model, "");
  assert.match(String(handleCommand("oc_chat", "/model bad name!")), /只能包含/);

  const project = store.current("oc_chat");
  store.setSession("oc_chat", project, "s1", "第一件事");
  assert.match(String(handleCommand("oc_chat", "/new")), /开启新会话/);
  assert.equal(store.getSession("oc_chat", project), undefined);
  assert.ok(isCard(handleCommand("oc_chat", "/history")));
  assert.match(String(handleCommand("oc_chat", "/history 1")), /已切回会话：第一件事/);
  assert.equal(store.getSession("oc_chat", project), "s1");
  assert.match(String(handleCommand("oc_chat", "/history 7")), /没有找到/);

  assert.match(String(handleCommand("oc_chat", "/stop")), /没有正在执行的任务/);
  assert.ok(isCard(handleCommand("oc_chat", "/status")));
  assert.ok(isCard(handleCommand("oc_chat", "/about")));
  assert.ok(isCard(handleCommand("oc_chat", "/whatever")), "unknown commands show the help card");
});

test("threads have their own session but share the command set", () => {
  const thread = "oc_chat#omt_1";
  const project = store.current(thread);
  assert.equal(store.getSession(thread, project), undefined);
  store.setSession(thread, project, "thread-s", "话题里的事");
  assert.match(String(handleCommand(thread, "/new")), /开启新会话/);
  assert.equal(store.getSession(thread, project), undefined);
  assert.equal(store.getSession("oc_chat", project), "s1", "the chat's own session is untouched");
});

test("incoming messages: text, image, file, rich text", () => {
  assert.deepEqual(parseIncoming("text", JSON.stringify({ text: "@_user_1 你好 " })), { text: "你好", images: [], files: [] });
  assert.deepEqual(parseIncoming("image", JSON.stringify({ image_key: "img_1" })), { text: "", images: ["img_1"], files: [] });
  assert.deepEqual(parseIncoming("file", JSON.stringify({ file_key: "f_1", file_name: "a.pdf" })), {
    text: "",
    images: [],
    files: [{ key: "f_1", name: "a.pdf" }],
  });
  const post = {
    title: "标题",
    content: [
      [{ tag: "at", user_id: "@_user_1" }, { tag: "text", text: "看这张图" }],
      [{ tag: "img", image_key: "img_2" }],
    ],
  };
  assert.deepEqual(parseIncoming("post", JSON.stringify(post)), { text: "标题\n看这张图", images: ["img_2"], files: [] });
  assert.equal(parseIncoming("sticker", "{}"), undefined);
  assert.equal(parseIncoming("text", "not json"), undefined);
});

test("owner-only card actions", () => {
  assert.equal(isOwnerOnly({ a: "interval", seconds: 10 }), true);
  assert.equal(isOwnerOnly({ a: "decide", id: "a1", ok: true }), true);
  assert.equal(isOwnerOnly({ a: "sched_run", id: "t1" }), true);
  assert.equal(isOwnerOnly({ a: "show", view: "allow" }), true);
  assert.equal(isOwnerOnly({ a: "show", view: "status" }), false);
  assert.equal(isOwnerOnly({ a: "use", project: "alpha" }), false);
  assert.equal(isOwnerOnly({ a: "stop", key: "k" }), false);
});

test("scheduled tasks: add, pause, remove", () => {
  const now = new Date(2026, 10, 23, 10, 0, 0).getTime();
  assert.match(addTask("oc_chat", "alpha", "ou_owner", "每天 09:00 检查状态", now), /已添加定时任务：每天 09:00/);
  assert.equal(typeof addTask("oc_chat", "alpha", "ou_owner", "乱写", now), "string");
  const [task] = listTasks("oc_chat");
  assert.equal(task.prompt, "检查状态");
  assert.equal(task.nextAt, new Date(2026, 10, 24, 9, 0, 0).getTime());
  assert.equal(toggleTask(task.id, now)?.enabled, false);
  assert.equal(listTasks("oc_chat")[0].nextAt, undefined);
  assert.equal(toggleTask(task.id, now)?.enabled, true);
  assert.equal(removeTask(task.id)?.id, task.id);
  assert.equal(listTasks("oc_chat").length, 0);
  assert.equal(listTasks("another").length, 0);
});

// ---------- 多个 agent ----------

const { allAgents, agentOf, findAgent } = await import("../src/agents/index.ts");
const codexAgent = await import("../src/agents/codex.ts");
const { AGENT_IDS } = await import("../src/cli/manage.ts");

test("agents: registry, lookup, and the terminal's list stays in sync", () => {
  assert.deepEqual(allAgents().map((a) => a.id), AGENT_IDS);
  assert.equal(agentOf("nope").id, "claude", "unknown ids fall back to the default");
  assert.equal(findAgent("Codex")?.id, "codex");
  assert.equal(findAgent("claude code")?.id, "claude");
  assert.equal(findAgent("gpt"), undefined);
});

test("slash commands: /agent switches per chat, and /model follows the agent", () => {
  assert.ok(isCard(handleCommand("oc_agent", "/agent")));
  assert.match(String(handleCommand("oc_agent", "/agent gpt")), /没有叫/);
  assert.match(String(handleCommand("oc_agent", "/agent codex")), /已切换到 Codex/);
  assert.equal(store.agent("oc_agent"), "codex");
  assert.equal(store.agent("oc_chat"), "claude", "other chats are unaffected");

  handleCommand("oc_agent", "/model some-codex-model");
  assert.equal(settings.codexModel, "some-codex-model");
  assert.equal(settings.model, "", "Claude's model is untouched");
  handleCommand("oc_agent", "/model default");
  assert.equal(settings.codexModel, "");
  assert.ok(isCard(handleCommand("oc_agent", "/model")));
  assert.ok(isCard(handleCommand("oc_agent", "/status")));
  assert.match(String(handleCommand("oc_agent", "/agent claude")), /已切换到 Claude Code/);
});

test("Codex: permission level maps onto its sandbox", () => {
  assert.deepEqual(codexAgent.sandboxFor(["Read", "Glob", "Grep"]), { sandboxMode: "read-only" });
  assert.deepEqual(codexAgent.sandboxFor(["Read", "Edit", "Write"]), {
    sandboxMode: "workspace-write",
    networkAccessEnabled: false,
  });
  assert.deepEqual(codexAgent.sandboxFor(["Read", "Edit", "Write", "Bash"]), {
    sandboxMode: "workspace-write",
    networkAccessEnabled: true,
  });
});

test("Codex: steps are described, and the shell wrapper is hidden", () => {
  assert.equal(codexAgent.plainCommand("/bin/zsh -lc 'cat README.md'"), "cat README.md");
  assert.equal(codexAgent.plainCommand("/bin/zsh -lc ls"), "ls");
  assert.equal(codexAgent.plainCommand("git status"), "git status");
  assert.equal(
    codexAgent.describeItem({ id: "1", type: "command_execution", command: "/bin/zsh -lc ls", aggregated_output: "", status: "in_progress" }),
    "运行 ls",
  );
  assert.equal(
    codexAgent.describeItem({ id: "2", type: "file_change", status: "completed", changes: [{ path: "/p/a.ts", kind: "update" }, { path: "/p/b.ts", kind: "add" }] }),
    "修改 a.ts、b.ts",
  );
  assert.equal(codexAgent.describeItem({ id: "3", type: "reasoning", text: "…" }), undefined);
});

test("Codex: send_file markers are taken out of the reply", () => {
  const r = codexAgent.extractSendFiles("报告做好了。\n[[send_file: /tmp/report.pdf]]\n\n还有一张图：\n  [[send_file: `out/chart.png`]]  \n完。");
  assert.deepEqual(r.paths, ["/tmp/report.pdf", "out/chart.png"]);
  assert.equal(r.text, "报告做好了。\n\n还有一张图：\n\n完。");
  assert.deepEqual(codexAgent.extractSendFiles("行内的 [[send_file: x]] 不算").paths, []);
});

// ---------- 不能发卡片时的文字版 ----------

test("every card has a text version that still tells you what to type", () => {
  for (const command of ["/help", "/use", "/status", "/model", "/agent", "/setting", "/history", "/about"]) {
    const r = handleCommand("oc_chat", command) as { fallback?: string };
    assert.ok(r.fallback && r.fallback.length > 10, `${command} has a text fallback`);
  }
});

// ---------- 会话兜底、日志轮转 ----------

const { isSessionGone } = await import("../src/jobs.ts");
const service = await import("../src/service.ts");
const fsx = await import("node:fs");
const pathx = await import("node:path");

test("a missing session is recognised for both agents (messages copied from real runs)", () => {
  assert.equal(isSessionGone(new Error("Claude Code returned an error result: No conversation found with session ID: 1111")), true);
  assert.equal(
    isSessionGone(new Error("Codex Exec exited with code 1: Reading prompt from stdin...\nError: thread/resume: thread/resume failed: no rollout found for thread id 1111 (code -32600)")),
    true,
  );
  assert.equal(isSessionGone(new Error("rate limit exceeded")), false);
  assert.equal(isSessionGone(new Error("Not logged in")), false);
});

test("the service log is rotated once it grows past the limit", () => {
  fsx.mkdirSync(pathx.dirname(service.LOG_FILE), { recursive: true });
  fsx.writeFileSync(service.LOG_FILE, "small\n");
  service.housekeeping();
  assert.equal(fsx.readFileSync(service.LOG_FILE, "utf8"), "small\n", "small logs are left alone");
  fsx.writeFileSync(service.LOG_FILE, Buffer.alloc(service.LOG_MAX_BYTES + 1, "x"));
  service.housekeeping();
  assert.equal(fsx.statSync(service.LOG_FILE).size, 0);
  assert.equal(fsx.statSync(`${service.LOG_FILE}.1`).size, service.LOG_MAX_BYTES + 1, "one backup is kept");
});
