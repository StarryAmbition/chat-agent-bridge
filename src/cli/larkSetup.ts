// 配置向导和诊断用到的 Lark 操作：验证凭证、扫码创建应用、等用户在群里 @ 机器人。

import * as lark from "@larksuiteoapi/node-sdk";

export type DomainName = "lark" | "feishu";

/** 向导和诊断自己负责向用户说明情况，不需要 SDK 的任何输出 */
const silent = { error: (): void => {}, warn: (): void => {}, info: (): void => {}, debug: (): void => {}, trace: (): void => {} };

const DOMAINS: Record<DomainName, lark.Domain> = { lark: lark.Domain.Lark, feishu: lark.Domain.Feishu };

export const CONSOLE_URL: Record<DomainName, string> = {
  lark: "https://open.larksuite.com/app",
  feishu: "https://open.feishu.cn/app",
};

/** 应用需要的权限、事件和回调。手动创建时按这份清单勾选，扫码创建时自动带上。 */
export const REQUIRED = {
  scopes: [
    ["im:message", "读取与发送消息"],
    ["im:message:send_as_bot", "以机器人身份发消息"],
    ["im:message.group_at_msg:readonly", "接收群里 @机器人 的消息"],
    ["im:message.group_msg", "接收群里的所有消息（持续对话需要）"],
    ["im:message.p2p_msg:readonly", "接收单聊消息"],
    ["im:resource", "读取和上传消息里的图片、文件"],
    ["im:chat:readonly", "读取群信息和群成员"],
  ],
  events: [["im.message.receive_v1", "接收消息"]],
  callbacks: [["card.action.trigger", "卡片按钮点击"]],
} as const;

export function makeClient(appId: string, appSecret: string, domain: DomainName): lark.Client {
  return new lark.Client({ appId, appSecret, domain: DOMAINS[domain], logger: silent, loggerLevel: lark.LoggerLevel.fatal });
}

export function describeLarkError(err: unknown): string {
  const data = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  if (data?.msg) return `${data.msg}${data.code ? `（错误码 ${data.code}）` : ""}`;
  return err instanceof Error ? err.message : String(err);
}

export interface BotInfo {
  name: string;
  openId: string;
}

/** 用凭证读取机器人信息，以此验证凭证和域名是否正确。 */
export async function fetchBot(appId: string, appSecret: string, domain: DomainName): Promise<BotInfo> {
  const res = await makeClient(appId, appSecret, domain).request<{
    bot?: { app_name?: string; open_id?: string };
    msg?: string;
  }>({ method: "GET", url: "/open-apis/bot/v3/info" });
  if (!res.bot?.open_id) throw new Error(res.msg || "应用没有开启机器人能力");
  return { name: res.bot.app_name ?? "机器人", openId: res.bot.open_id };
}

/**
 * 验证凭证。域名选错是很常见的问题（国内版和国际版的应用互不相通），
 * 所以当前域名失败时会自动换另一个试一次。
 */
export async function verifyCredentials(
  appId: string,
  appSecret: string,
  preferred: DomainName,
): Promise<{ domain: DomainName; bot: BotInfo } | { error: string }> {
  const order: DomainName[] = preferred === "lark" ? ["lark", "feishu"] : ["feishu", "lark"];
  let firstError = "";
  for (const domain of order) {
    try {
      return { domain, bot: await fetchBot(appId, appSecret, domain) };
    } catch (err) {
      firstError ||= describeLarkError(err);
    }
  }
  return { error: firstError };
}

export interface Mention {
  senderId: string;
  chatId: string;
  isGroup: boolean;
}

/**
 * 连上长连接，等有人给机器人发消息（群里 @ 它，或者单聊）。超时返回 undefined。
 * 能等到消息，就说明事件订阅、长连接方式和应用发布都配置对了。
 */
export function waitForMention(
  appId: string,
  appSecret: string,
  domain: DomainName,
  botOpenId: string,
  timeoutMs: number,
): Promise<Mention | undefined> {
  return new Promise((resolve) => {
    const ws = new lark.WSClient({ appId, appSecret, domain: DOMAINS[domain], logger: silent, loggerLevel: lark.LoggerLevel.fatal });
    let done = false;
    const finish = (value: Mention | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close({ force: true });
      } catch {
        // 连接可能还没建立
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const dispatcher = new lark.EventDispatcher({ logger: silent, loggerLevel: lark.LoggerLevel.fatal }).register({
      "im.message.receive_v1": async (data) => {
        const { message, sender } = data;
        const isGroup = message.chat_type !== "p2p";
        const mentioned = (message.mentions ?? []).some((m) => m.id.open_id === botOpenId);
        if (isGroup && !mentioned) return;
        const senderId = sender.sender_id?.open_id;
        if (senderId) finish({ senderId, chatId: message.chat_id, isGroup });
      },
    });
    ws.start({ eventDispatcher: dispatcher }).catch(() => finish(undefined));
  });
}

/** 群名和发消息的人的名字，取不到时返回空字符串。 */
export async function describeMention(
  client: lark.Client,
  mention: Mention,
): Promise<{ chatName: string; senderName: string }> {
  let chatName = "";
  let senderName = "";
  try {
    const chat = await client.im.chat.get({ path: { chat_id: mention.chatId } });
    chatName = chat.data?.name ?? "";
  } catch {
    // 没有权限时就不显示名字
  }
  try {
    const members = await client.im.chatMembers.get({
      path: { chat_id: mention.chatId },
      params: { member_id_type: "open_id", page_size: 100 },
    });
    senderName = members.data?.items?.find((m) => m.member_id === mention.senderId)?.name ?? "";
  } catch {
    // 同上
  }
  return { chatName, senderName };
}

/**
 * 扫码创建应用：用户用 Lark/飞书扫码并确认后，平台按预设的权限和事件建好应用，
 * 返回凭证和扫码人的 ID。onUrl 用来把二维码地址显示给用户。
 */
export async function createAppByScan(onUrl: (url: string, expiresInSeconds: number) => void): Promise<{
  appId: string;
  appSecret: string;
  domain: DomainName;
  ownerOpenId: string;
}> {
  const result = await lark.registerApp({
    createOnly: true,
    onQRCodeReady: (info) => onUrl(info.url, info.expireIn),
    appPreset: {
      name: "Claude Code Bridge",
      desc: "在群里和这台电脑上的 Claude Code 对话",
    },
    addons: {
      scopes: { tenant: REQUIRED.scopes.map(([scope]) => scope) },
      events: { items: { tenant: REQUIRED.events.map(([event]) => event) } },
      callbacks: { items: REQUIRED.callbacks.map(([callback]) => callback) },
    },
  });
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    domain: result.user_info?.tenant_brand === "feishu" ? "feishu" : "lark",
    ownerOpenId: result.user_info?.open_id ?? "",
  };
}
