// 下载消息里的附件，组装成交给 agent 的内容。

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sniffImage } from "./tools.js";
import { INBOX_DIR } from "./config.js";
import { Block } from "./jobs.js";
import { download } from "./chat.js";
import { type Incoming } from "./platforms/types.js";

export { extractText, parseIncoming } from "./platforms/larkParse.js";
export type { Incoming } from "./platforms/types.js";

export const MAX_INLINE_IMAGE_BYTES = 4_500_000;

/** 把图片和文件下载到本机，组装成发给 Claude 的内容。图片直接给它看，文件告诉它路径。 */
export async function buildContent(messageId: string, incoming: Incoming): Promise<string | Block[]> {
  if (incoming.images.length === 0 && incoming.files.length === 0) return incoming.text;
  const dir = join(INBOX_DIR, messageId.replace(/[^\w-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  const blocks: Block[] = [];

  for (const [i, key] of incoming.images.entries()) {
    const path = join(dir, `image-${i + 1}`);
    await download(messageId, key, "image", path);
    const bytes = readFileSync(path);
    const mediaType = sniffImage(bytes);
    if (mediaType && bytes.length <= MAX_INLINE_IMAGE_BYTES) {
      blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } });
    } else {
      notes.push(`用户发来一张图片，已保存在本机：${path}`);
    }
  }
  for (const file of incoming.files) {
    const safeName = file.name.replace(/[\/\\\0]/g, "_").slice(0, 120) || "file";
    const path = join(dir, safeName);
    await download(messageId, file.key, "file", path);
    notes.push(`用户发来一个文件「${file.name}」，已保存在本机：${path}`);
  }

  const text =
    [incoming.text, ...notes].filter(Boolean).join("\n\n") ||
    (blocks.length > 1 ? "（用户发来了几张图片）" : "（用户发来了一张图片）");
  return blocks.length ? [{ type: "text", text }, ...blocks] : text;
}
