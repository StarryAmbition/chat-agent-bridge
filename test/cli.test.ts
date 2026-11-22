import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "bridge-cli-"));
process.env.BRIDGE_DATA_DIR = dir;
const store = await import("../src/cli/store.ts");

test("config round trip, with the file readable only by the owner", () => {
  assert.equal(store.loadConfig(), undefined);
  store.saveConfig({
    appId: "cli_1",
    appSecret: "s",
    domain: "lark",
    ownerOpenId: "ou_1",
    allowedChatIds: ["oc_1"],
    allowedTools: [...store.TOOL_LEVELS.full],
    authMode: "subscription",
  });
  assert.equal(store.loadConfig()?.appId, "cli_1");
  assert.equal(statSync(store.configPath()).mode & 0o777, 0o600);
});

test("incomplete or broken config is treated as missing", () => {
  writeFileSync(store.configPath(), JSON.stringify({ appId: "cli_1" }));
  assert.equal(store.loadConfig(), undefined);
  writeFileSync(store.configPath(), "not json");
  assert.equal(store.loadConfig(), undefined);
});

test("defaults are conservative", () => {
  writeFileSync(store.configPath(), JSON.stringify({ appId: "cli_1", appSecret: "s" }));
  const config = store.loadConfig();
  assert.deepEqual(config?.allowedTools, ["Read", "Glob", "Grep"], "read-only unless chosen otherwise");
  assert.equal(config?.authMode, "subscription");
  assert.deepEqual(config?.allowedChatIds, []);
});

test("applyEnv exports what the bridge reads", () => {
  store.saveProjects({ demo: dir });
  store.applyEnv({
    appId: "cli_2",
    appSecret: "sec",
    domain: "feishu",
    ownerOpenId: "ou_2",
    allowedChatIds: ["a", "b"],
    allowedTools: ["Read", "Bash"],
    authMode: "api_key",
    apiKey: "sk-test",
  });
  assert.equal(process.env.LARK_APP_ID, "cli_2");
  assert.equal(process.env.LARK_DOMAIN, "feishu");
  assert.equal(process.env.ALLOWED_CHAT_IDS, "a,b");
  assert.equal(process.env.ALLOWED_TOOLS, "Read,Bash");
  assert.equal(process.env.AUTH_MODE, "api_key");
  assert.equal(process.env.ANTHROPIC_API_KEY, "sk-test");
  assert.equal(process.env.CLAUDE_CWD, dir);
});

test("parseEnvFile reads an old .env", () => {
  const file = join(dir, ".env");
  writeFileSync(file, '# comment\nLARK_APP_ID=cli_9\nLARK_APP_SECRET="quoted"\nEMPTY=\n  ALLOWED_TOOLS = Read,Glob \n');
  assert.deepEqual(store.parseEnvFile(file), {
    LARK_APP_ID: "cli_9",
    LARK_APP_SECRET: "quoted",
    EMPTY: "",
    ALLOWED_TOOLS: "Read,Glob",
  });
});

// ---------- 在终端里修改配置 ----------

const manage = await import("../src/cli/manage.ts");
const ui = await import("../src/cli/ui.ts");

const base = {
  appId: "cli_1",
  appSecret: "s",
  domain: "lark" as const,
  ownerOpenId: "ou_owner",
  allowedChatIds: ["oc_1"],
  allowedTools: [...store.TOOL_LEVELS.readonly],
  authMode: "subscription" as const,
};

test("projects can be added and removed, but never the last one", () => {
  store.saveProjects({});
  assert.equal(manage.addProject(join(dir, "missing")).ok, false, "directory must exist");
  assert.equal(manage.addProject(dir, "bad name").ok, false, "names are used in chat commands");
  assert.equal(manage.addProject(dir, "one").ok, true);
  assert.equal(manage.addProject(tmpdir(), "two").ok, true);
  assert.deepEqual(Object.keys(store.loadProjects()), ["one", "two"]);
  assert.equal(manage.removeProject("ONE").ok, true, "case-insensitive");
  assert.equal(manage.removeProject("two").ok, false, "keeps the last project");
  assert.equal(manage.removeProject("nope").ok, false);
});

test("dragged-in paths are cleaned up", () => {
  assert.equal(manage.cleanDir("'/tmp/a b' "), "/tmp/a b");
  assert.equal(manage.cleanDir("/tmp/a\\ b"), "/tmp/a b");
});

test("permission level is written to the config", () => {
  store.saveConfig(base);
  assert.equal(manage.levelOf(base.allowedTools), "readonly");
  manage.setLevel(base, "full");
  assert.equal(manage.levelOf(store.loadConfig()!.allowedTools), "full");
});

test("allowlist edits validate ids and never include the owner", () => {
  assert.equal(manage.allowAdd(base, "someone").ok, false);
  assert.equal(manage.allowAdd(base, "ou_owner").ok, false);
  assert.equal(manage.allowAdd(base, "ou_a", "甲").ok, true);
  assert.equal(manage.allowAdd(base, "ou_a", "甲").ok, false, "no duplicates");
  assert.equal(manage.allowRemove(base, "甲").ok, true, "by name");
  assert.equal(manage.allowRemove(base, "甲").ok, false);
});

test("a running bridge picks up allowlist edits made elsewhere", () => {
  const running = manage.allowlistOf(base);
  assert.equal(running.reload(), false, "nothing changed");
  manage.allowAdd(base, "ou_b", "乙");
  assert.equal(running.has("ou_b"), false);
  assert.equal(running.reload(), true);
  assert.equal(running.has("ou_b"), true);
});

test("settings: values are validated, and a running bridge picks up edits", async () => {
  const s = await manage.settingsModule(base);
  assert.equal(manage.applySetting(s, "interval", "abc").ok, false);
  assert.equal(manage.applySetting(s, "interval", "99999").ok, false);
  assert.equal(manage.applySetting(s, "follow", "maybe").ok, false);
  assert.equal(manage.applySetting(s, "model", "bad model!").ok, false);
  assert.equal(manage.applySetting(s, "interval", "45").ok, true);
  assert.equal(manage.applySetting(s, "approve", "off").ok, true);
  assert.equal(manage.applySetting(s, "model", "default").ok, true);
  assert.equal(s.loadSettings().intervalSeconds, 45);
  assert.equal(s.loadSettings().approve, false);

  // 模拟另一个进程改了文件
  writeFileSync(s.SETTINGS_FILE, JSON.stringify({ ...s.loadSettings(), intervalSeconds: 5 }));
  assert.equal(s.settings.intervalSeconds, 45);
  assert.equal(s.reloadSettings(), true);
  assert.equal(s.settings.intervalSeconds, 5);
  assert.equal(s.reloadSettings(), false);
});

test("chat ids are validated", () => {
  assert.equal(manage.chatAdd(base, "nope").ok, false);
  assert.equal(manage.chatAdd(base, "oc_1").ok, false, "already listed");
  assert.equal(manage.chatAdd(base, "oc_2").ok, true);
  assert.deepEqual(store.loadConfig()!.allowedChatIds, ["oc_1", "oc_2"]);
});

test("menu columns line up with Chinese text", () => {
  assert.equal(ui.displayWidth("abc"), 3);
  assert.equal(ui.displayWidth("项目ab"), 6);
  assert.equal(ui.padTo("开", 4), "开  ");
});

test("default agent and Codex model can be set from the terminal", async () => {
  const s = await manage.settingsModule(base);
  assert.equal(manage.applySetting(s, "agent", "gpt").ok, false);
  assert.equal(manage.applySetting(s, "agent", "codex").ok, true);
  assert.equal(s.loadSettings().agent, "codex");
  assert.equal(manage.applySetting(s, "codex-model", "some-model").ok, true);
  assert.equal(s.loadSettings().codexModel, "some-model");
  assert.equal(manage.applySetting(s, "agent", "claude").ok, true);
});
