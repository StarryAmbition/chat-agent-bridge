// 收发消息的统一入口。其他模块都从这里发消息，不直接碰具体的聊天平台。

import { type Member } from "./allowlist.js";
import { logError } from "./log.js";
import { platform } from "./platforms/index.js";

/** 用表格展示的回复：标题 + 表头 + 若干行，可带一段补充说明。 */
export interface TableReply {
  title: string;
  columns: string[];
  rows: string[][];
  note?: string;
}

/** 带按钮的卡片回复；fallback 是不能发卡片时的纯文本版本。 */
export interface CardReply {
  card: object;
  fallback: string;
}

export type Reply = string | TableReply | CardReply;

export function tableCard(t: TableReply): object {
  const elements: object[] = [
    {
      tag: "table",
      page_size: Math.min(Math.max(t.rows.length, 1), 10),
      row_height: "low",
      header_style: { bold: true, background_style: "grey" },
      columns: t.columns.map((name, i) => ({
        name: `c${i}`,
        display_name: name,
        data_type: "text",
        width: "auto",
      })),
      rows: t.rows.map((row) => Object.fromEntries(row.map((cell, i) => [`c${i}`, cell]))),
    },
  ];
  if (t.note) elements.push({ tag: "markdown", content: t.note });
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: t.title }, template: "blue" },
    body: { elements },
  };
}

export function tableAsText(t: TableReply): string {
  const lines = t.rows.map((row) => row.join("  —  "));
  return [t.title, ...lines, ...(t.note ? [t.note] : [])].join("\n");
}

/** 这个平台能不能发带按钮、可更新的卡片 */
export const canUseCards = (): boolean => platform.features.cards;

export const describeError = (err: unknown): string => platform.describeError(err);

export function replyText(messageId: string, text: string, opts?: { mention?: string }): Promise<void> {
  return platform.replyText(messageId, text, opts);
}

/**
 * 回复一条消息。能发卡片的平台上，按钮卡片和表格用卡片；
 * 不能发卡片的平台上用它们的文字版（纯文本，里面写了该发什么命令）。
 * 无论哪种，失败时都退回纯文本，保证消息一定能发出去。
 */
export async function reply(messageId: string, content: Reply): Promise<void> {
  if (typeof content === "string") return platform.replyMarkdown(messageId, content);
  const isCard = "card" in content;
  const fallback = isCard ? content.fallback : tableAsText(content);
  if (!platform.replyCard) return platform.replyText(messageId, fallback);
  try {
    await platform.replyCard(messageId, isCard ? content.card : tableCard(content));
  } catch (err) {
    logError("卡片发送失败，改用纯文本", describeError(err));
    await platform.replyText(messageId, fallback);
  }
}

/** 回复一张卡片并返回它的 ID（之后可以原地更新）。平台不支持卡片时返回 undefined。 */
export async function replyCard(messageId: string, card: object): Promise<string | undefined> {
  return platform.replyCard ? platform.replyCard(messageId, card) : undefined;
}

export async function patchCard(cardMessageId: string, card: object): Promise<void> {
  await platform.patchCard?.(cardMessageId, card);
}

/** 往群里发一条新消息（不是引用回复），用于按钮触发的异步结果、重启通知等。 */
export async function send(chatId: string, content: Reply): Promise<void> {
  if (typeof content === "string") {
    await platform.sendText(chatId, content);
    return;
  }
  const isCard = "card" in content;
  const fallback = isCard ? content.fallback : tableAsText(content);
  if (isCard && platform.sendCard) {
    try {
      await platform.sendCard(chatId, content.card);
      return;
    } catch (err) {
      logError("卡片发送失败，改用纯文本", describeError(err));
    }
  }
  await platform.sendText(chatId, fallback);
}

/** 往群里发一条文本并返回它的 ID，之后的结果可以引用回复这条消息。 */
export function sendText(chatId: string, text: string): Promise<string | undefined> {
  return platform.sendText(chatId, text);
}

export function download(messageId: string, key: string, kind: "image" | "file", dest: string): Promise<void> {
  return platform.download(messageId, key, kind, dest);
}

export function replyFile(messageId: string, path: string, kind: "image" | "file"): Promise<string | undefined> {
  return platform.replyFile(messageId, path, kind);
}

export function members(chatId: string): Promise<Member[]> {
  return platform.members(chatId);
}
