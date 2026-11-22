import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Allowlist } from "../src/allowlist.ts";
import { parentScope, ProjectStore } from "../src/projects.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-store-"));
  const a = join(dir, "a");
  const b = join(dir, "b");
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ alpha: a, beta: b, ghost: join(dir, "missing") }));
  const make = () => new ProjectStore(join(dir, "projects.json"), join(dir, "state.json"), a);
  return { dir, a, make };
}

test("switching projects by number or name, and rejecting bad targets", () => {
  const { make } = setup();
  const store = make();
  assert.equal(store.current("chat").name, "alpha");
  assert.equal((store.use("chat", "2") as { name: string }).name, "beta");
  assert.equal((store.use("chat", "ALPHA") as { name: string }).name, "alpha");
  assert.equal(typeof store.use("chat", "nope"), "string");
  assert.equal(typeof store.use("chat", "ghost"), "string", "directory does not exist");
  assert.equal(store.current("chat").name, "alpha", "failed switches change nothing");
});

test("each project keeps its own session, and state survives a reload", () => {
  const { make } = setup();
  const store = make();
  const alpha = store.current("chat");
  store.setSession("chat", alpha, "s1", "first");
  const beta = store.use("chat", "beta") as { name: string; cwd: string };
  assert.equal(store.getSession("chat", beta), undefined);
  const reloaded = make();
  assert.equal(reloaded.current("chat").name, "beta");
  assert.equal(reloaded.getSession("chat", alpha), "s1");
});

test("a thread inherits the chat's project once, then keeps its own", () => {
  const { make } = setup();
  const store = make();
  store.use("chat", "beta");
  assert.equal(store.current("chat#t1").name, "beta");
  store.use("chat", "alpha");
  assert.equal(store.current("chat#t1").name, "beta", "pinned at first use");
  assert.equal(store.current("chat#t2").name, "alpha");
  const beta = store.current("chat#t1");
  store.setSession("chat#t1", beta, "thread-session");
  assert.equal(store.getSession("chat", beta), undefined, "thread session is separate from the chat's");
  assert.equal(parentScope("chat#t1"), "chat");
  assert.equal(parentScope("chat"), "chat");
});

test("history keeps recent sessions and lets you switch back", () => {
  const { make } = setup();
  const store = make();
  const p = store.current("chat");
  store.setSession("chat", p, "s1", "修登录 bug", 1000);
  store.clearSession("chat", p);
  assert.equal(store.getSession("chat", p), undefined);
  store.setSession("chat", p, "s2", "写文档", 2000);
  store.setSession("chat", p, "s2", "这个标题不该覆盖", 3000);
  const history = store.history("chat", p);
  assert.deepEqual(history.map((r) => [r.id, r.title, r.lastUsedAt]), [["s2", "写文档", 3000], ["s1", "修登录 bug", 1000]]);
  assert.equal(store.resume("chat", p, "2")?.id, "s1");
  assert.equal(store.getSession("chat", p), "s1");
  assert.equal(store.resume("chat", p, "s2")?.id, "s2");
  assert.equal(store.resume("chat", p, "9"), undefined);
  for (let i = 0; i < 15; i++) store.setSession("chat", p, `x${i}`, "", 4000 + i);
  assert.equal(store.history("chat", p).length, 10, "capped");
});

test("reads the old flat state format", () => {
  const { dir, make } = setup();
  writeFileSync(join(dir, "state.json"), JSON.stringify({ chat: "old-session" }));
  const store = make();
  assert.equal(store.getSession("chat", store.current("chat")), "old-session");
});

test("allowlist add, remove, persistence and owner protection", () => {
  const file = join(mkdtempSync(join(tmpdir(), "bridge-allow-")), "allow.json");
  const list = new Allowlist(file, "owner");
  assert.equal(list.add({ id: "u1", name: "小明" }), true);
  assert.equal(list.add({ id: "u1", name: "小明" }), false);
  assert.equal(list.add({ id: "owner", name: "me" }), false);
  assert.deepEqual(new Allowlist(file, "owner").list(), [{ id: "u1", name: "小明" }]);
  assert.equal(list.remove("u1")?.name, "小明");
  assert.equal(list.remove("u1"), undefined);
  assert.equal(new Allowlist(file, "owner").has("u1"), false);
});

test("each agent keeps its own session and history", () => {
  const { make } = setup();
  const store = make();
  const alpha = store.current("chat");
  assert.equal(store.agent("chat"), "claude", "default agent");
  store.setSession("chat", alpha, "claude-1", "with claude");

  store.setAgent("chat", "codex");
  assert.equal(store.getSession("chat", alpha), undefined, "Codex starts fresh");
  store.setSession("chat", alpha, "codex-1", "with codex");
  assert.deepEqual(store.history("chat", alpha).map((r) => r.id), ["codex-1"]);

  // 任务提交时就定下了 agent：中途切换后，它的会话仍然记到原来那个 agent 名下
  store.setSession("chat", alpha, "claude-2", "late result", Date.now(), "claude");
  assert.equal(store.getSession("chat", alpha), "codex-1");

  store.setAgent("chat", "claude");
  assert.equal(store.getSession("chat", alpha), "claude-2");
  const reloaded = make();
  assert.equal(reloaded.agent("chat"), "claude");
  assert.equal(reloaded.getSession("chat", alpha, "codex"), "codex-1");
});

test("a thread inherits the chat's agent once, and unset chats follow the default", () => {
  const { dir, a } = setup();
  let fallback = "claude";
  const store = new ProjectStore(join(dir, "projects.json"), join(dir, "state.json"), a, () => fallback);
  fallback = "codex";
  assert.equal(store.agent("chat"), "codex", "follows the default until chosen");
  store.setAgent("chat", "claude");
  assert.equal(store.agent("chat#t1"), "claude");
  store.setAgent("chat", "codex");
  assert.equal(store.agent("chat#t1"), "claude", "the thread keeps what it started with");
});
