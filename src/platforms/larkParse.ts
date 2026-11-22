// 解析 Lark / 飞书的消息内容（文字、图片、文件、富文本）。纯函数，不依赖其他模块。

import { type Incoming } from "./types.js";

export function extractText(content: string): string {
  try {
    const text = (JSON.parse(content) as { text?: string }).text ?? "";
    // 去掉 @机器人 的占位符，如 "@_user_1"
    return text.replace(/@_user_\d+/g, "").trim();
  } catch {
    return "";
  }
}

/** 解析一条消息的内容；不支持的消息类型返回 undefined。 */
export function parseIncoming(type: string, content: string): Incoming | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  switch (type) {
    case "text":
      return { text: extractText(content), images: [], files: [] };
    case "image":
      return typeof raw.image_key === "string"
        ? { text: "", images: [raw.image_key], files: [] }
        : undefined;
    case "file":
      return typeof raw.file_key === "string"
        ? { text: "", images: [], files: [{ key: raw.file_key, name: String(raw.file_name ?? "file") }] }
        : undefined;
    case "post": {
      // 富文本：文字和图片混排。@ 的人不计入文字
      const incoming: Incoming = { text: "", images: [], files: [] };
      const lines: string[] = typeof raw.title === "string" && raw.title ? [raw.title] : [];
      for (const line of Array.isArray(raw.content) ? raw.content : []) {
        let current = "";
        for (const node of Array.isArray(line) ? (line as Record<string, unknown>[]) : []) {
          if (node.tag === "text" || node.tag === "a") current += String(node.text ?? "");
          else if (node.tag === "img" && typeof node.image_key === "string") incoming.images.push(node.image_key);
        }
        lines.push(current);
      }
      incoming.text = lines.join("\n").trim();
      return incoming;
    }
    default:
      return undefined;
  }
}
