// 持久化的状态：项目列表与会话、白名单，以及账号的角色判断。

import { Allowlist } from "./allowlist.js";
import { ProjectStore } from "./projects.js";
import { AUTH_MODE, CLAUDE_CWD, dataFile, OWNER_OPEN_ID } from "./config.js";
import { settings } from "./settings.js";

export const allowlist = new Allowlist(
  dataFile("allowlist.json"),
  OWNER_OPEN_ID,
);

export type Role = "owner" | "member" | "none";

export function roleOf(openId: string): Role {
  if (OWNER_OPEN_ID && openId === OWNER_OPEN_ID) return "owner";
  return allowlist.has(openId) ? "member" : "none";
}

// projects.json 是允许切换的项目列表；state.json 记录每个群当前在哪个项目、各项目的会话。

export const store = new ProjectStore(
  dataFile("projects.json"),
  dataFile("state.json"),
  CLAUDE_CWD,
  () => settings.agent,
);

/** 订阅登录只限账号持有人本人使用：这个模式下白名单成员发来的指令不执行，回这段说明。 */
export const MEMBERS_NEED_API_KEY =
  "你在白名单里，但机器人现在用的是主人的个人订阅登录，按订阅条款只能由主人本人使用。" +
  "主人把 bridge 切换到 API key 模式后，你就可以直接对话了。";

/** 这个角色现在能不能指挥机器人 */
export function canCommand(role: Role): boolean {
  return role === "owner" || (role === "member" && AUTH_MODE === "api_key");
}
