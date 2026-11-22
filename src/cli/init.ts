// 配置向导：把一个新用户从零带到 bridge 可以启动。

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import qrcode from "qrcode-terminal";
import { claudeAccount, runClaudeLogin } from "./claude.js";
import {
  CONSOLE_URL,
  createAppByScan,
  describeLarkError,
  describeMention,
  makeClient,
  REQUIRED,
  verifyCredentials,
  waitForMention,
  type BotInfo,
  type DomainName,
} from "./larkSetup.js";
import {
  configPath,
  dataDir,
  loadConfig,
  loadProjects,
  parseEnvFile,
  saveConfig,
  saveProjects,
  TOOL_LEVELS,
  type BridgeConfig,
} from "./store.js";
import { ask, askSecret, bold, choose, command, confirm, dim, fail, hint, ok, requireTerminal, say, step, warn } from "./ui.js";

const TOTAL = 6;
const DATA_FILES = ["projects.json", "settings.json", "state.json", "allowlist.json", "schedules.json"];

function expand(path: string): string {
  return resolve(path.startsWith("~") ? homedir() + path.slice(1) : path);
}

/** 从旧的手动安装（一个带 .env 的目录）迁移配置和数据。 */
export function importFrom(dir: string): void {
  const source = expand(dir);
  const envFile = join(source, ".env");
  if (!existsSync(envFile)) {
    fail(`${envFile} 不存在。--import 后面要跟原来那个带 .env 的目录。`);
    process.exit(1);
  }
  const env = parseEnvFile(envFile);
  if (!env.LARK_APP_ID || !env.LARK_APP_SECRET) {
    fail("这个 .env 里没有 LARK_APP_ID 和 LARK_APP_SECRET。");
    process.exit(1);
  }
  const list = (v = ""): string[] => v.split(",").map((s) => s.trim()).filter(Boolean);
  saveConfig({
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    domain: env.LARK_DOMAIN === "lark" ? "lark" : "feishu",
    ownerOpenId: env.OWNER_OPEN_ID ?? "",
    allowedChatIds: list(env.ALLOWED_CHAT_IDS),
    allowedTools: list(env.ALLOWED_TOOLS).length ? list(env.ALLOWED_TOOLS) : [...TOOL_LEVELS.readonly],
    authMode: env.AUTH_MODE === "api_key" ? "api_key" : "subscription",
    ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
  });
  mkdirSync(dataDir(), { recursive: true });
  const copied: string[] = [];
  for (const name of DATA_FILES) {
    if (existsSync(join(source, name)) && !existsSync(join(dataDir(), name))) {
      copyFileSync(join(source, name), join(dataDir(), name));
      copied.push(name);
    }
  }
  ok(`已从 ${source} 导入配置，保存在 ${configPath()}`);
  if (copied.length) hint(`同时复制了数据文件：${copied.join("、")}`);
  hint("原目录没有改动。确认新的安装工作正常后，记得停掉原来那个，否则两个会抢消息。");
  say(`\n下一步：${bold("chat-agent-bridge doctor")} 检查一遍，然后 ${bold("chat-agent-bridge start")}。`);
}

async function stepClaude(): Promise<{ authMode: "subscription" | "api_key"; apiKey?: string }> {
  step(1, TOTAL, "检查 Claude Code");
  return chooseClaudeAuth();
}

/** 选择调用 Claude 的方式并验证能用。向导和控制面板共用。 */
export async function chooseClaudeAuth(): Promise<{ authMode: "subscription" | "api_key"; apiKey?: string }> {
  const authMode = await choose<"subscription" | "api_key">("bridge 用哪种方式调用 Claude？", [
    { label: "这台电脑上 Claude Code 的订阅登录", note: "只有你本人能指挥机器人", value: "subscription" },
    { label: "API key", note: "按量计费；可以把其他人加进白名单", value: "api_key" },
  ]);
  if (authMode === "api_key") {
    for (;;) {
      const apiKey = await askSecret("请粘贴 Anthropic API key（输入时不显示）：");
      if (!apiKey) continue;
      say(dim("正在验证…"));
      const account = await claudeAccount(apiKey);
      if (account.loggedIn) {
        ok("API key 可以使用。");
        return { authMode, apiKey };
      }
      fail(`这个 key 没有通过验证${account.error ? `：${account.error}` : ""}`);
    }
  }
  for (;;) {
    say(dim("正在检查登录状态…"));
    const account = await claudeAccount();
    if (account.loggedIn) {
      ok(`Claude Code 已登录${account.subscription ? `（${account.subscription} 订阅）` : ""}。`);
      return { authMode };
    }
    warn("这台电脑上的 Claude Code 还没有登录。");
    if (await confirm("现在登录吗？会打开浏览器，用你的 Claude 账号授权。")) {
      await runClaudeLogin();
    } else {
      hint("之后可以自己登录，然后重新运行 chat-agent-bridge init。");
      process.exit(1);
    }
  }
}

function printManualChecklist(domain: DomainName): void {
  say(`\n请在浏览器里打开开发者后台：${bold(CONSOLE_URL[domain])}`);
  say("按下面的顺序操作，每一步做完再做下一步：\n");
  say(`  ${bold("1.")} 点「创建企业自建应用」，填一个名字（它就是机器人在群里的名字）。`);
  say(`  ${bold("2.")} 左侧「添加应用能力」→ 添加「机器人」。`);
  say(`  ${bold("3.")} 左侧「权限管理」→ 搜索并开通这些权限：`);
  for (const [scope, note] of REQUIRED.scopes) say(`       ${scope.padEnd(36)} ${dim(note)}`);
  say(`  ${bold("4.")} 左侧「版本管理与发布」→ 创建版本并发布。`);
  hint("     如果你不是企业管理员，要等管理员审批通过。");
  say(`  ${bold("5.")} 左侧「凭证与基础信息」→ 复制 App ID 和 App Secret，粘贴到下面。`);
  hint("     事件订阅放到下一步配置，因为它要求 bridge 先连上。");
}

async function stepApp(existing?: BridgeConfig): Promise<{
  appId: string;
  appSecret: string;
  domain: DomainName;
  bot: BotInfo;
  ownerOpenId: string;
  manual: boolean;
}> {
  step(2, TOTAL, "准备 Lark / 飞书应用");
  if (existing) {
    const check = await verifyCredentials(existing.appId, existing.appSecret, existing.domain);
    if (!("error" in check) && (await confirm(`已经配置过应用「${check.bot.name}」，继续用它吗？`))) {
      return { ...existing, domain: check.domain, bot: check.bot, manual: false };
    }
  }
  const how = await choose<"scan" | "manual">("机器人需要一个你自己的应用。怎么创建？", [
    { label: "扫码创建", note: "用手机扫一下，权限和事件自动配好（较新的功能）", value: "scan" },
    { label: "手动创建，或者已经有应用了", note: "按清单在开发者后台操作", value: "manual" },
  ]);

  if (how === "scan") {
    say("\n请用 Lark 或飞书扫描二维码，在手机上确认创建：\n");
    try {
      const app = await createAppByScan((url, expires) => {
        qrcode.generate(url, { small: true }, (qr) => say(qr));
        hint(`扫不了的话，在已登录的浏览器里打开：${url}`);
        hint(`二维码 ${Math.round(expires / 60)} 分钟内有效。等待确认中…`);
      });
      const check = await verifyCredentials(app.appId, app.appSecret, app.domain);
      if ("error" in check) throw new Error(check.error);
      ok(`应用「${check.bot.name}」已创建（${check.domain === "lark" ? "Lark 国际版" : "飞书"}）。`);
      return { ...app, domain: check.domain, bot: check.bot, manual: false };
    } catch (err) {
      fail(`扫码创建没有成功：${describeLarkError(err)}`);
      hint("改用手动方式继续。");
    }
  }

  let domain = await choose<DomainName>("你用的是哪个版本？", [
    { label: "Lark（国际版）", note: "open.larksuite.com", value: "lark" },
    { label: "飞书（国内版）", note: "open.feishu.cn", value: "feishu" },
  ]);
  printManualChecklist(domain);
  for (;;) {
    const appId = await ask("\nApp ID（cli_ 开头）：");
    const appSecret = await askSecret("App Secret（输入时不显示）：");
    if (!appId || !appSecret) continue;
    say(dim("正在验证…"));
    const check = await verifyCredentials(appId, appSecret, domain);
    if ("error" in check) {
      fail(`验证没有通过：${check.error}`);
      hint("常见原因：复制时多了空格；应用没有添加「机器人」能力；App Secret 被重置过。");
      continue;
    }
    if (check.domain !== domain) {
      warn(`这个应用其实是${check.domain === "lark" ? " Lark 国际版" : "飞书国内版"}的，已自动改过来。`);
      domain = check.domain;
    }
    ok(`凭证有效，机器人名叫「${check.bot.name}」。`);
    return { appId, appSecret, domain, bot: check.bot, ownerOpenId: "", manual: true };
  }
}

async function stepOwner(app: Awaited<ReturnType<typeof stepApp>>, existing?: BridgeConfig): Promise<{ ownerOpenId: string; chatIds: string[] }> {
  step(3, TOTAL, "连接群聊，确认你是主人");
  if (existing?.ownerOpenId && existing.appId === app.appId) {
    if (await confirm("已经设置过主人和群，保持不变吗？")) {
      return { ownerOpenId: existing.ownerOpenId, chatIds: existing.allowedChatIds };
    }
  }
  if (app.manual) {
    say("bridge 现在会连上 Lark。请趁它在线的时候，回到开发者后台完成事件订阅：\n");
    say(`  ${bold("1.")} 左侧「事件与回调」→「事件配置」→ 订阅方式选「使用长连接接收事件」并保存。`);
    for (const [event, note] of REQUIRED.events) say(`  ${bold("2.")} 添加事件 ${bold(event)} ${dim(note)}`);
    say(`  ${bold("3.")} 切到「回调配置」→ 订阅方式同样选长连接。`);
    for (const [callback, note] of REQUIRED.callbacks) say(`  ${bold("4.")} 添加回调 ${bold(callback)} ${dim(note)}`);
    say(`  ${bold("5.")} 再创建一个版本并发布（每次改动都要重新发布才生效）。\n`);
  }
  say(`然后：${bold(`把「${app.bot.name}」拉进一个群，在群里 @ 它随便说一句话。`)}`);
  hint("拉进群：群设置 → 群机器人 → 添加机器人 → 搜索它的名字。");

  const client = makeClient(app.appId, app.appSecret, app.domain);
  for (;;) {
    say(dim("\n等待你的消息（最多 3 分钟）…"));
    const mention = await waitForMention(app.appId, app.appSecret, app.domain, app.bot.openId, 180_000);
    if (!mention) {
      warn("没有收到消息。逐项检查：");
      hint("1. 「事件与回调」里订阅方式是不是长连接，有没有添加 im.message.receive_v1。");
      hint("2. 改动之后有没有创建新版本并发布成功（需要管理员审批的要等通过）。");
      hint("3. 机器人是不是已经在那个群里，消息有没有 @ 它。");
      hint("4. 有没有别的程序在用同一个应用。同一个应用只会把消息发给其中一个程序。");
      if (!(await confirm("再等一次吗？"))) process.exit(1);
      continue;
    }
    const { chatName, senderName } = await describeMention(client, mention);
    const who = senderName || `…${mention.senderId.slice(-6)}`;
    const where = mention.isGroup ? `群「${chatName || mention.chatId.slice(-6)}」` : "单聊";
    ok(`收到了：${who} 在${where}里发来消息。`);
    if (await confirm(`把 ${who} 设为主人（唯一能指挥机器人的人），并只在这个${mention.isGroup ? "群" : "会话"}里响应？`)) {
      return { ownerOpenId: mention.senderId, chatIds: [mention.chatId] };
    }
    say("好，请让要当主人的人再 @ 一次。");
  }
}

async function stepProjects(): Promise<void> {
  step(4, TOTAL, "选择项目目录");
  say("Claude 只在你列出的目录里工作。可以加多个，之后在群里用 /use 切换。");
  const projects = loadProjects();
  for (const [name, dir] of Object.entries(projects)) hint(`已有：${name}  ${dir}`);
  for (;;) {
    const first = Object.keys(projects).length === 0;
    const input = await ask(first ? "项目目录的路径（可以把文件夹拖进终端）：" : "再加一个？直接回车结束：");
    if (!input) {
      if (first) continue;
      break;
    }
    const dir = expand(input.replace(/\\ /g, " ").replace(/^['"]|['"]$/g, ""));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      fail(`${dir} 不是一个存在的目录。`);
      continue;
    }
    const name = await ask("给它起个短名字：", basename(dir));
    projects[name] = dir;
    ok(`已添加 ${name}`);
  }
  saveProjects(projects);
}

async function stepPermissions(existing?: BridgeConfig): Promise<string[]> {
  step(5, TOTAL, "Claude 可以做什么");
  say("群里的一句话会在你的电脑上变成实际操作，请按需要选择：");
  const level = await choose<keyof typeof TOOL_LEVELS>(
    "",
    [
      { label: "只读", note: "只能看文件、搜索，不能改任何东西", value: "readonly" },
      { label: "可以改文件", note: "能编辑和新建文件，不能运行命令", value: "edit" },
      { label: "可以改文件并运行命令", note: "删除、推送、安装这类危险操作会先问你", value: "full" },
    ],
    existing?.allowedTools.includes("Bash") ? 3 : existing?.allowedTools.includes("Edit") ? 2 : 1,
  );
  if (level === "full") {
    warn("审批是按命令文字判断的，藏在脚本里的操作拦不住。不要把它当成安全边界。");
  }
  return [...TOOL_LEVELS[level]];
}

export async function runInit(): Promise<void> {
  requireTerminal();
  const existing = loadConfig();
  say(bold("\nChat Agent Bridge 配置向导"));
  say(dim(`配置和数据保存在 ${dataDir()}`));
  if (existing) hint("检测到已有配置，每一步都可以选择保留。");

  const claude = await stepClaude();
  const app = await stepApp(existing);
  // 先把应用凭证存下来，后面的步骤中断了也不用重填
  const partial: BridgeConfig = {
    appId: app.appId,
    appSecret: app.appSecret,
    domain: app.domain,
    ownerOpenId: app.ownerOpenId || (existing?.appId === app.appId ? existing.ownerOpenId : ""),
    allowedChatIds: existing?.appId === app.appId ? existing.allowedChatIds : [],
    allowedTools: existing?.allowedTools ?? [...TOOL_LEVELS.readonly],
    authMode: claude.authMode,
    ...(claude.apiKey ? { apiKey: claude.apiKey } : {}),
  };
  saveConfig(partial);

  const owner = await stepOwner(app, partial.ownerOpenId && partial.allowedChatIds.length ? partial : undefined);
  saveConfig({ ...partial, ownerOpenId: owner.ownerOpenId, allowedChatIds: owner.chatIds });

  await stepProjects();
  const allowedTools = await stepPermissions(existing);
  saveConfig({ ...partial, ownerOpenId: owner.ownerOpenId, allowedChatIds: owner.chatIds, allowedTools });

  step(6, TOTAL, "完成");
  ok(`配置已保存到 ${configPath()}`);
  say("\n现在可以启动了：");
  command("chat-agent-bridge start");
  say("想让它开机自启、在后台一直运行：");
  command("chat-agent-bridge service install");
  say("其他命令：");
  hint("chat-agent-bridge          控制面板：启动之后随时修改项目、权限和各项设置");
  hint("chat-agent-bridge doctor   出问题时自动检查哪里不对");
  hint("chat-agent-bridge awake    合上盖子也保持运行的设置方法");
  hint("在群里 @机器人 不说话，可以看到全部聊天命令");
}
