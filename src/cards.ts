// 卡片的基础组件（按钮、行、卡片外壳）和按钮动作的类型。

/** 按钮点击后回传的数据。a 是动作名。 */
export type CardAction =
  | { a: "use"; project: string }
  | { a: "new" }
  | { a: "follow"; on: boolean }
  | { a: "interval"; seconds: number }
  | { a: "allow_add"; id: string; name: string }
  | { a: "allow_remove"; id: string }
  | { a: "approval"; on: boolean }
  | { a: "idle"; minutes: number }
  | { a: "model"; model: string }
  | { a: "agent"; agent: string }
  | { a: "decide"; id: string; ok: boolean }
  | { a: "stop"; key: string }
  | { a: "compact" }
  | { a: "resume"; id: string }
  | { a: "sched_del"; id: string }
  | { a: "sched_toggle"; id: string }
  | { a: "sched_run"; id: string }
  | { a: "show"; view: "use" | "setting" | "help" | "usage" | "allow" | "status" | "about" | "host" | "model" | "history" | "schedule" | "agent" };

/** 只有主人能做的动作：改设置、管理白名单。 */
export function isOwnerOnly(action: CardAction): boolean {
  return (
    action.a === "follow" ||
    action.a === "interval" ||
    action.a === "approval" ||
    action.a === "idle" ||
    action.a === "model" ||
    action.a === "agent" ||
    action.a === "decide" ||
    action.a === "sched_del" ||
    action.a === "sched_toggle" ||
    action.a === "sched_run" ||
    action.a === "allow_add" ||
    action.a === "allow_remove" ||
    (action.a === "show" && (action.view === "setting" || action.view === "allow" || action.view === "schedule"))
  );
}

export function button(
  label: string,
  action: CardAction,
  opts: { primary?: boolean; danger?: boolean; disabled?: boolean } = {},
): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: opts.danger ? "danger" : opts.primary ? "primary" : "default",
    size: "small",
    disabled: opts.disabled ?? false,
    behaviors: [{ type: "callback", value: action }],
  };
}

/** 一行：左边是说明文字，右边是若干按钮。 */
export function row(markdown: string, buttons: object[]): object {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [{ tag: "markdown", content: markdown }],
      },
      ...buttons.map((b) => ({
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [b],
      })),
    ],
  };
}

export function card(title: string, elements: object[]): object {
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: title }, template: "blue" },
    body: { elements },
  };
}

export const NAV = {
  use: button("项目", { a: "show", view: "use" }),
  setting: button("设置", { a: "show", view: "setting" }),
  help: button("命令列表", { a: "show", view: "help" }),
  status: button("状态", { a: "show", view: "status" }),
  about: button("功能介绍", { a: "show", view: "about" }),
  host: button("宿主机", { a: "show", view: "host" }),
  model: button("模型", { a: "show", view: "model" }),
  agent: button("切换 agent", { a: "show", view: "agent" }),
  history: button("历史会话", { a: "show", view: "history" }),
  schedule: button("定时任务", { a: "show", view: "schedule" }),
  usage: button("用量", { a: "show", view: "usage" }),
  allow: button("白名单", { a: "show", view: "allow" }),
};
