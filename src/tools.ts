import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/** 判断命令风险、描述工具调用、识别图片类型：都是不依赖 Lark 和 Claude 的纯函数。 */

const RISKY: [RegExp, string][] = [
  [/(^|[;&|(\s])sudo\s/, "使用管理员权限"],
  [/(^|[;&|(\s])(rm|rmdir|unlink|shred)\s/, "删除文件"],
  [/\bgit\s+(push|reset\s+--hard|clean\b|branch\s+-D|rebase|checkout\s+--|restore\b|stash\s+(drop|clear))/, "改动或推送 git 历史"],
  [/\bgh\s+(pr\s+(merge|close)|repo\s+delete|release\s+(create|delete))/, "操作 GitHub 上的内容"],
  [/\b(npm|pnpm|yarn|bun|pip3?|uv|brew|gem|cargo|go)\s+(install|add|i|uninstall|remove|rm|upgrade|update)\b/, "安装或卸载软件"],
  [/\b(npm|pnpm|yarn|cargo|twine)\s+publish\b|\b(vercel|wrangler|netlify|fly|firebase)\b.*\b(deploy|publish)\b/, "发布或部署"],
  [/\b(curl|wget)\b[^|;&]*\|\s*(ba|z)?sh\b/, "下载并直接执行脚本"],
  [/(^|[;&|(\s])(chmod|chown)\s/, "修改文件权限"],
  [/(^|[;&|(\s])(kill|pkill|killall)\s/, "结束进程"],
  [/(^|[;&|(\s])(launchctl|systemctl|crontab)\s/, "修改系统服务或定时任务"],
  [/(^|[;&|(\s])(shutdown|reboot|halt)\b/, "关机或重启"],
  [/(^|[;&|(\s])(dd|mkfs\S*|diskutil)\s/, "操作磁盘"],
  [/\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/, "删除 Docker 资源"],
  [/\b(drop\s+(table|database)|truncate\s+table|delete\s+from)\b/i, "删除数据库数据"],
  [/\bfind\b.*\s-(delete|exec\s+rm)\b/, "批量删除文件"],
  [/(^|[;&|(\s])truncate\s/, "清空文件"],
  [
    /\b(python3?|node|deno|bun|perl|ruby|php)\b.*\s-(c|e|r)\b.*(rmtree|os\.remove|os\.unlink|unlink|rmSync|rmdir|removeSync|File\.delete|FileUtils\.rm)/,
    "用脚本删除文件",
  ],
  [/\bgit\s+commit\b.*--amend\b/, "改写上一次提交"],
  [
    /(~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+|\/root)\/\.(ssh|aws|gnupg|kube|docker|netrc|npmrc|pypirc|claude|codex|chat-agent-bridge|config\/(gh|gcloud))\b/,
    "读取密钥或登录凭证",
  ],
  [/\/etc\/(shadow|sudoers|master\.passwd)\b|\bsecurity\s+(find|dump)-|\/Keychains\//, "读取密钥或登录凭证"],
];

/** 命令有风险时返回原因（用于审批卡片），否则返回 undefined。 */
export function riskOf(command: string): string | undefined {
  for (const [pattern, reason] of RISKY) {
    if (pattern.test(command)) return reason;
  }
  return undefined;
}

/**
 * 要修改的文件是否在项目目录之外。
 * 只做路径层面的判断（不解析符号链接），足够拦住"改到别的项目或系统文件"这类情况。
 */
export function outsideProject(projectDir: string, filePath: unknown): boolean {
  if (typeof filePath !== "string" || !filePath) return false;
  const root = resolve(projectDir);
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  return target !== root && !target.startsWith(root + sep);
}

/** 把路径里的符号链接解开；路径还不存在时，解开它已经存在的那一段上级目录。 */
function realPath(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(current.slice(parent.length).replace(/^[/\\]/, ""));
      current = parent;
    }
  }
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** 读取类的工具，以及它们各自用哪个参数指定位置 */
const READ_TOOL_PATHS: Record<string, string> = {
  Read: "file_path",
  NotebookRead: "notebook_path",
  Glob: "path",
  Grep: "path",
};

export function isReadTool(tool: string): boolean {
  return tool in READ_TOOL_PATHS;
}

/**
 * 一次读取是不是落在允许的范围之外。允许的范围是项目目录、临时目录，以及 extraRoots（比如收到的附件所在的目录）。
 * 会解开符号链接，所以项目里一个指向外面的链接不能用来绕过。
 */
export function readsOutside(
  projectDir: string,
  tool: string,
  input: Record<string, unknown>,
  extraRoots: string[] = [],
): boolean {
  const key = READ_TOOL_PATHS[tool];
  if (!key) return false;
  const raw = input[key];
  // 没有指定位置时，这些工具默认在项目目录里找
  if (typeof raw !== "string" || !raw) return false;
  const root = realPath(resolve(projectDir));
  const target = realPath(isAbsolute(raw) ? resolve(raw) : resolve(root, raw));
  const roots = [root, ...[tmpdir(), "/tmp", ...extraRoots].map((r) => realPath(resolve(r)))];
  return !roots.some((r) => inside(r, target));
}

function short(value: unknown, max = 80): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function baseName(path: unknown): string {
  return String(path ?? "").split("/").filter(Boolean).pop() ?? "";
}

/** 把一次工具调用写成一行人能看懂的话，用在进度卡片里。 */
export function describeStep(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Read":
      return `读取 ${baseName(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `修改 ${baseName(input.file_path)}`;
    case "Write":
      return `写入 ${baseName(input.file_path)}`;
    case "Bash":
      return `运行 ${short(input.command, 70)}`;
    case "Glob":
      return `查找文件 ${short(input.pattern, 50)}`;
    case "Grep":
      return `搜索 ${short(input.pattern, 50)}`;
    case "WebSearch":
      return `联网搜索 ${short(input.query, 50)}`;
    case "WebFetch":
      return `打开网页 ${short(input.url, 60)}`;
    case "Agent":
    case "Task":
      return `启动子任务 ${short(input.description, 50)}`;
    default:
      return `使用 ${tool}`;
  }
}

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** 按文件头判断图片类型；不是支持的图片格式时返回 undefined。 */
export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  const b = bytes;
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
