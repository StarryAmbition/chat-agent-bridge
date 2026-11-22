// 宿主机状态：CPU、内存、磁盘、电量。

import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { formatDuration } from "./tools.js";
import { button, card, NAV, row } from "./cards.js";
import { SUPERVISED } from "./config.js";
import { lanes, runningCount } from "./jobs.js";
import { CardReply } from "./chat.js";
import { bar } from "./usage.js";

export const run = promisify(execFile);

export async function output(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 8000, maxBuffer: 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

export function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** 收集这台电脑的状态。每一项单独取，取不到的就不显示。 */
export async function hostCard(): Promise<CardReply> {
  const [version, top, vmStat, battery, ps] = await Promise.all([
    output("sw_vers", ["-productVersion"]),
    output("top", ["-l", "1", "-n", "0"]),
    output("vm_stat", []),
    output("pmset", ["-g", "batt"]),
    output("ps", ["-Aro", "pcpu=,pmem=,comm="]),
  ]);
  const sections: string[][] = [];

  const cpus = os.cpus();
  const load = os.loadavg().map((n) => n.toFixed(2)).join(" / ");
  const idle = /([\d.]+)% idle/.exec(top);
  const cpuUsed = idle ? 100 - Number(idle[1]) : undefined;
  const system = [
    `**主机**：${os.hostname()}`,
    `**系统**：${os.platform() === "darwin" ? "macOS" : os.platform()} ${version.trim() || os.release()}`,
    `**已开机**：${formatDuration(os.uptime() * 1000)}`,
  ];
  sections.push(system);

  const cpu = [
    `**处理器**：${cpus[0]?.model ?? "未知"}，${cpus.length} 核`,
    ...(cpuUsed === undefined ? [] : [`**CPU 占用**：${bar(cpuUsed)} ${Math.round(cpuUsed)}%`]),
    `**负载**（1 / 5 / 15 分钟）：${load}`,
  ];
  sections.push(cpu);

  // 内存：macOS 上 os.freemem() 不含可回收的缓存，会显得几乎用满；按 vm_stat 的活跃+联动+压缩来算
  const total = os.totalmem();
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1] ?? 0);
  const pages = (name: string): number => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(vmStat)?.[1] ?? 0);
  const used = pageSize
    ? (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * pageSize
    : total - os.freemem();
  sections.push([`**内存**：${bar((used / total) * 100)} ${Math.round((used / total) * 100)}%（已用 ${gb(used)} / 共 ${gb(total)}）`]);

  try {
    const fsStat = statfsSync(os.homedir());
    const diskTotal = fsStat.blocks * fsStat.bsize;
    const diskFree = fsStat.bavail * fsStat.bsize;
    const diskUsed = diskTotal - diskFree;
    sections.push([
      `**磁盘**：${bar((diskUsed / diskTotal) * 100)} ${Math.round((diskUsed / diskTotal) * 100)}%（已用 ${gb(diskUsed)} / 共 ${gb(diskTotal)}，剩余 ${gb(diskFree)}）`,
    ]);
  } catch {
    // 取不到磁盘信息就不显示
  }

  const batt = /(\d+)%;\s*([a-z ]+);/i.exec(battery);
  if (batt) {
    const state: Record<string, string> = {
      charging: "充电中",
      discharging: "使用电池",
      charged: "已充满",
      "finishing charge": "即将充满",
      "AC attached": "已接电源，未在充电",
    };
    const onAC = battery.includes("AC Power") && batt[2].trim() !== "AC attached";
    sections.push([`**电量**：${batt[1]}%，${state[batt[2].trim()] ?? batt[2].trim()}${onAC ? "，已接电源" : ""}`]);
  }

  const topProcs = ps
    .split("\n")
    .map((line) => /^\s*([\d.]+)\s+([\d.]+)\s+(.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .slice(0, 5)
    .map((m) => `${m[3].split("/").pop()}　CPU ${m[1]}%　内存 ${m[2]}%`);
  if (topProcs.length) sections.push(["**占用 CPU 最多的进程**", ...topProcs]);

  const queued = [...lanes.values()].reduce((n, l) => n + l.pending.length, 0);
  sections.push([
    `**bridge**：已运行 ${formatDuration(process.uptime() * 1000)}，占用内存 ${Math.round(process.memoryUsage().rss / 1024 ** 2)} MB`,
    `**任务**：${runningCount()} 个执行中，${queued} 个排队`,
    `**运行方式**：${SUPERVISED ? "后台自启服务" : "终端手动启动"}`,
  ]);

  return {
    card: card("宿主机状态", [
      ...sections.flatMap((lines, i) => [
        ...(i > 0 ? [{ tag: "hr" }] : []),
        { tag: "markdown", content: lines.join("\n") },
      ]),
      { tag: "hr" },
      row("", [button("刷新", { a: "show", view: "host" }), NAV.status, NAV.usage, NAV.help]),
    ]),
    fallback: sections.map((lines) => lines.join("\n").replace(/\*\*/g, "")).join("\n\n"),
  };
}
