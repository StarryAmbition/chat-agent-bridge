// 聊天平台的统一接口。bridge 只通过这个接口收发消息，
// 所以接入一个新的平台只需要：在这个目录里实现 Platform，然后在 index.ts 里登记。

import { type Member } from "../allowlist.js";

/** 一条消息里我们关心的内容 */
export interface Incoming {
  text: string;
  /** 图片的下载凭据，交给 download() 用 */
  images: string[];
  files: { key: string; name: string }[];
}

/** 平台收到的一条消息，已经整理成统一的样子 */
export interface ChatMessage {
  messageId: string;
  chatId: string;
  /** 话题 ID；平台没有话题或者消息不在话题里时为空 */
  threadId?: string;
  senderId: string;
  /** 平台顺带给出了发送人名字的话填上，省得再查 */
  senderName?: string;
  /** 是不是单聊 */
  direct: boolean;
  mentionsBot: boolean;
  /** 消息里 @ 的其他人（不含机器人自己） */
  mentionedOthers: Member[];
  mentionsAll: boolean;
  /** 解析出来的内容；这种消息类型不支持时为空 */
  incoming?: Incoming;
}

export interface PlatformHandlers {
  message(message: ChatMessage): void;
  /** 卡片按钮被点击。参数和返回值是平台自己的格式，只有支持卡片的平台会调用 */
  cardAction(event: unknown): object;
  /** 连接状态变化：断开了、恢复了、彻底连不上了（重试用尽） */
  connection(state: "lost" | "restored" | "failed", detail?: string): void;
}

/** 各个平台能力不一样的地方 */
export interface PlatformFeatures {
  /** 能不能发带按钮、可以原地更新的卡片。不能的话一律退回文字加斜杠命令 */
  cards: boolean;
  /** 群里不 @ 机器人的消息收不收得到。收不到的话"持续对话"不起作用 */
  ambient: boolean;
}

export interface Platform {
  id: string;
  /** 显示给人看的名字 */
  name: string;
  features: PlatformFeatures;
  /** 连接平台并开始接收消息 */
  start(handlers: PlatformHandlers): Promise<void>;
  /** 现在连接是不是正常 */
  connected(): boolean;

  /** 用纯文本回复一条消息。mention 是要 @ 的人 */
  replyText(messageId: string, text: string, opts?: { mention?: string }): Promise<void>;
  /** 用 Markdown 回复一条消息 */
  replyMarkdown(messageId: string, markdown: string): Promise<void>;
  /** 往群里发一条文本（不是回复）。返回这条消息的 ID，之后可以回复它 */
  sendText(chatId: string, text: string): Promise<string | undefined>;

  /** 下面三个只有 features.cards 为 true 的平台需要实现。card 是 Lark 卡片 JSON */
  replyCard?(messageId: string, card: object): Promise<string | undefined>;
  sendCard?(chatId: string, card: object): Promise<void>;
  patchCard?(cardMessageId: string, card: object): Promise<void>;

  /** 把用户发来的图片或文件下载到本机 */
  download(messageId: string, key: string, kind: "image" | "file", dest: string): Promise<void>;
  /** 把本机的一个文件作为回复发出去。成功返回 undefined，失败返回原因 */
  replyFile(messageId: string, path: string, kind: "image" | "file"): Promise<string | undefined>;
  /** 群成员列表；平台查不到时返回空数组 */
  members(chatId: string): Promise<Member[]>;
  /** 把平台接口的错误整理成一行 */
  describeError(err: unknown): string;
}
