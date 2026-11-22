import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSpec, nextRun, parseSchedule } from "../src/schedule.ts";

// 2026-11-23 是周一
const monday10 = new Date(2026, 10, 23, 10, 0, 0);
const at = (d: number, h: number, m = 0): number => new Date(2026, 10, d, h, m, 0).getTime();

function parsed(text: string) {
  const r = parseSchedule(text, monday10);
  assert.equal(typeof r, "object", `should parse: ${text} -> ${r}`);
  return r as Exclude<typeof r, string>;
}

test("parses daily, weekday and weekly rules", () => {
  assert.deepEqual(parsed("每天 09:00 检查状态"), { spec: { kind: "daily", hour: 9, minute: 0 }, prompt: "检查状态" });
  assert.deepEqual(parsed("工作日 9：30 看看 CI").spec, { kind: "daily", hour: 9, minute: 30, days: [1, 2, 3, 4, 5] });
  assert.deepEqual(parsed("每周日 20:00 写周报").spec, { kind: "daily", hour: 20, minute: 0, days: [0] });
});

test("parses intervals and one-off times", () => {
  assert.deepEqual(parsed("每 30 分钟 看一下队列").spec, { kind: "every", minutes: 30 });
  assert.deepEqual(parsed("每2小时 同步").spec, { kind: "every", minutes: 120 });
  assert.deepEqual(parsed("今天 18:30 提醒我").spec, { kind: "once", at: at(23, 18, 30) });
  assert.deepEqual(parsed("明天 08:00 提醒我").spec, { kind: "once", at: at(24, 8) });
});

test("keeps multi-line prompts", () => {
  assert.equal(parsed("每天 09:00 第一行\n第二行").prompt, "第一行\n第二行");
});

test("rejects bad input with a message", () => {
  for (const text of ["每天 25:00 x", "每 2 分钟 x", "今天 09:00 已经过了", "每天 09:00", "随便写点什么"]) {
    assert.equal(typeof parseSchedule(text, monday10), "string", text);
  }
});

test("nextRun for daily rules", () => {
  const daily = { kind: "daily", hour: 9, minute: 0 } as const;
  assert.equal(nextRun(daily, at(23, 8)), at(23, 9));
  assert.equal(nextRun(daily, at(23, 9)), at(24, 9), "exactly at the time moves to the next day");
  const weekdays = { ...daily, days: [1, 2, 3, 4, 5] };
  assert.equal(nextRun(weekdays, at(27, 10)), at(30, 9), "Friday after 9 -> Monday");
  const sunday = { ...daily, days: [0] };
  assert.equal(nextRun(sunday, at(23, 10)), at(29, 9));
});

test("nextRun for interval and one-off rules", () => {
  assert.equal(nextRun({ kind: "every", minutes: 30 }, at(23, 10)), at(23, 10, 30));
  assert.equal(nextRun({ kind: "once", at: at(23, 18) }, at(23, 10)), at(23, 18));
  assert.equal(nextRun({ kind: "once", at: at(23, 18) }, at(23, 18)), undefined);
});

test("describeSpec", () => {
  assert.equal(describeSpec({ kind: "daily", hour: 9, minute: 5 }), "每天 09:05");
  assert.equal(describeSpec({ kind: "daily", hour: 9, minute: 0, days: [1, 2, 3, 4, 5] }), "工作日 09:00");
  assert.equal(describeSpec({ kind: "daily", hour: 9, minute: 0, days: [1] }), "每周一 09:00");
  assert.equal(describeSpec({ kind: "every", minutes: 120 }), "每 2 小时");
  assert.equal(describeSpec({ kind: "every", minutes: 45 }), "每 45 分钟");
});
