// 已接入的聊天平台。目前只有 Lark / 飞书。
// 要加一个新的：在这个目录里实现 Platform 接口，然后在这里按配置选择。

import { larkPlatform } from "./lark.js";
import { type Platform } from "./types.js";

export type { ChatMessage, Incoming, Platform, PlatformFeatures, PlatformHandlers } from "./types.js";

export const platform: Platform = larkPlatform;
