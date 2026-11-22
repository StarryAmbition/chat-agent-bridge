// Lark（国际版）和飞书（国内版）。用长连接接收事件，不需要公网 IP。

import * as lark from "@larksuiteoapi/node-sdk";
import { createReadStream } from "node:fs";
import { basename, extname } from "node:path";
import { type Member } from "../allowlist.js";
import { APP_ID, APP_SECRET, DOMAIN } from "../config.js";
import { logError, quietLarkLogger } from "../log.js";
import { parseIncoming } from "./larkParse.js";
import { type ChatMessage, type Platform } from "./types.js";

const MAX_CHUNK = 3500;

const FILE_TYPES: Record<string, "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt"> = {
  ".pdf": "pdf",
  ".doc": "doc",
  ".docx": "doc",
  ".xls": "xls",
  ".xlsx": "xls",
  ".csv": "xls",
  ".ppt": "ppt",
  ".pptx": "ppt",
  ".mp4": "mp4",
  ".opus": "opus",
};

/** 上传接口有的版本直接返回数据，有的包在 data 里，两种都认 */
export function uploadedKey(res: unknown, key: "file_key" | "image_key"): string | undefined {
  const r = res as Record<string, unknown> | null | undefined;
  const direct = r?.[key];
  const nested = (r?.data as Record<string, unknown> | undefined)?.[key];
  return typeof direct === "string" ? direct : typeof nested === "string" ? nested : undefined;
}

let ws: lark.WSClient | undefined;

let cached: lark.Client | undefined;
function client(): lark.Client {
  cached ??= new lark.Client({
    appId: APP_ID,
    appSecret: APP_SECRET,
    domain: DOMAIN,
    logger: quietLarkLogger,
    loggerLevel: lark.LoggerLevel.error,
  });
  return cached;
}

async function replyRaw(messageId: string, msg_type: string, content: object): Promise<string | undefined> {
  const res = await client().im.message.reply({
    path: { message_id: messageId },
    data: { msg_type, content: JSON.stringify(content) },
  });
  return res.data?.message_id;
}

async function createRaw(chatId: string, msg_type: string, content: object): Promise<string | undefined> {
  const res = await client().im.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, msg_type, content: JSON.stringify(content) },
  });
  return res.data?.message_id;
}

const markdownCard = (markdown: string): object => ({
  schema: "2.0",
  body: { elements: [{ tag: "markdown", content: markdown }] },
});

export const larkPlatform: Platform = {
  id: "lark",
  name: "Lark / 飞书",
  features: { cards: true, ambient: true },

  async start(handlers) {
    // 机器人自己的 open_id，用来判断群消息是不是 @ 了它
    const info = await client().request<{ bot?: { open_id?: string } }>({
      method: "GET",
      url: "/open-apis/bot/v3/info",
    });
    const botId = info.bot?.open_id ?? "";
    if (!botId) throw new Error("拿不到机器人自己的 open_id，无法判断消息是否 @ 了机器人");

    const dispatcher = new lark.EventDispatcher({
      logger: quietLarkLogger,
      loggerLevel: lark.LoggerLevel.error,
    }).register({
      // SDK 的类型定义里没有这个回调，但长连接会把它当作普通事件分发，返回值会回传给 Lark
      ...({ "card.action.trigger": async (data: unknown) => handlers.cardAction(data) } as object),
      "im.message.receive_v1": async (data) => {
        const { message, sender } = data;
        const mentions = message.mentions ?? [];
        const direct = message.chat_type === "p2p";
        const chat: ChatMessage = {
          messageId: message.message_id,
          chatId: message.chat_id,
          threadId: (message as { thread_id?: string }).thread_id || undefined,
          senderId: sender.sender_id?.open_id ?? "",
          direct,
          mentionsBot: !direct && mentions.some((m) => m.id.open_id === botId),
          mentionedOthers: mentions
            .filter((m) => m.id.open_id && m.id.open_id !== botId)
            .map((m) => ({ id: m.id.open_id as string, name: m.name })),
          // @所有人 不在 mentions 里，而是以 @_all 出现在正文中
          mentionsAll: message.content.includes("@_all"),
          incoming: parseIncoming(message.message_type, message.content),
        };
        handlers.message(chat);
      },
    });

    ws = new lark.WSClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      domain: DOMAIN,
      logger: quietLarkLogger,
      loggerLevel: lark.LoggerLevel.error,
      // 电脑睡眠或网络切换之后，旧连接可能"看起来还在、其实已经断了"。
      // 打开存活检测：发出心跳后 20 秒没有任何回音就重连；握手超过 15 秒也放弃重试
      wsConfig: { pingTimeout: 20 },
      handshakeTimeoutMs: 15_000,
      onReconnecting: () => handlers.connection("lost"),
      onReconnected: () => handlers.connection("restored"),
      onError: (err) => handlers.connection("failed", err.message),
    });
    ws.start({ eventDispatcher: dispatcher });
  },

  connected: () => ws?.getConnectionStatus().state === "connected",

  async replyText(messageId, text, opts) {
    const body = (opts?.mention ? `<at user_id="${opts.mention}"></at> ` : "") + (text.trim() || "（没有输出）");
    for (let i = 0; i < body.length; i += MAX_CHUNK) {
      await replyRaw(messageId, "text", { text: body.slice(i, i + MAX_CHUNK) });
    }
  },

  /** 文字放进卡片里的 Markdown 组件，这样加粗、列表、代码和表格都能正常显示；失败时退回纯文本。 */
  async replyMarkdown(messageId, markdown) {
    const body = markdown.trim() || "（没有输出）";
    for (let i = 0; i < body.length; i += MAX_CHUNK) {
      const chunk = body.slice(i, i + MAX_CHUNK);
      try {
        await replyRaw(messageId, "interactive", markdownCard(chunk));
      } catch (err) {
        logError("Markdown 卡片发送失败，改用纯文本", this.describeError(err));
        await replyRaw(messageId, "text", { text: chunk });
      }
    }
  },

  sendText: (chatId, text) => createRaw(chatId, "text", { text }),

  replyCard: (messageId, card) => replyRaw(messageId, "interactive", card),

  async sendCard(chatId, card) {
    await createRaw(chatId, "interactive", card);
  },

  async patchCard(cardMessageId, card) {
    await client().im.message.patch({
      path: { message_id: cardMessageId },
      data: { content: JSON.stringify(card) },
    });
  },

  async download(messageId, key, kind, dest) {
    const res = await client().im.messageResource.get({
      path: { message_id: messageId, file_key: key },
      params: { type: kind },
    });
    await res.writeFile(dest);
  },

  async replyFile(messageId, path, kind) {
    if (kind === "image") {
      const res = await client().im.image.create({
        data: { image_type: "message", image: createReadStream(path) },
      });
      const imageKey = uploadedKey(res, "image_key");
      if (!imageKey) return "图片上传失败。";
      await replyRaw(messageId, "image", { image_key: imageKey });
      return undefined;
    }
    const res = await client().im.file.create({
      data: {
        file_type: FILE_TYPES[extname(path).toLowerCase()] ?? "stream",
        file_name: basename(path),
        file: createReadStream(path),
      },
    });
    const fileKey = uploadedKey(res, "file_key");
    if (!fileKey) return "文件上传失败。";
    await replyRaw(messageId, "file", { file_key: fileKey });
    return undefined;
  },

  async members(chatId): Promise<Member[]> {
    const res = await client().im.chatMembers.get({
      path: { chat_id: chatId },
      params: { member_id_type: "open_id", page_size: 100 },
    });
    return (res.data?.items ?? [])
      .filter((m) => m.member_id)
      .map((m) => ({ id: m.member_id as string, name: m.name || (m.member_id as string) }));
  },

  describeError(err) {
    const data = (err as { response?: { data?: unknown } })?.response?.data;
    return data ? JSON.stringify(data).slice(0, 500) : String(err);
  },
};
