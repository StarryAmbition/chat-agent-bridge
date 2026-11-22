import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Project {
  name: string;
  cwd: string;
}

/** 历史里的一条会话记录 */
export interface SessionRecord {
  id: string;
  /** 这个会话的第一条指令，用来辨认 */
  title: string;
  startedAt: number;
  lastUsedAt: number;
}

interface State {
  /** 范围 -> 当前项目名 */
  current: Record<string, string>;
  /** "范围::项目名" -> 当前的 Claude session_id */
  sessions: Record<string, string>;
  /** "范围::项目名" -> 用过的会话，最近的在前 */
  history: Record<string, SessionRecord[]>;
  /** 范围 -> 选用的 agent */
  agents: Record<string, string>;
}

/** 最早只有这一个 agent，它的会话键不带后缀，这样旧数据不用迁移 */
const FIRST_AGENT = "claude";

const MAX_HISTORY = 10;

function expandHome(p: string): string {
  return resolve(p.startsWith("~") ? homedir() + p.slice(1) : p);
}

/** 话题范围 "群#话题" 所属的群；本身就是群时返回自己。 */
export function parentScope(scope: string): string {
  const i = scope.indexOf("#");
  return i === -1 ? scope : scope.slice(0, i);
}

/**
 * 管理"允许切换的项目列表"、每个范围当前所在的项目，以及会话。
 *
 * "范围"是一个群，或者群里的一个话题（写成 "群 ID#话题 ID"）。
 * 每个（范围, 项目, agent）组合有自己独立的会话，所以同一个群里的不同话题互不干扰，
 * 切换 agent 之后再切回来，原来的会话也还在。
 */
export class ProjectStore {
  private state: State;

  constructor(
    private readonly projectsFile: string,
    private readonly stateFile: string,
    private readonly fallbackCwd: string,
    /** 没有单独选过 agent 的范围用哪个 */
    private readonly defaultAgent: () => string = () => FIRST_AGENT,
  ) {
    this.state = this.loadState();
  }

  /** 每次都重新读文件，所以改 projects.json 不需要重启服务。 */
  list(): Project[] {
    try {
      const raw = JSON.parse(readFileSync(this.projectsFile, "utf8")) as Record<string, unknown>;
      const projects = Object.entries(raw)
        .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "")
        .map(([name, cwd]) => ({ name, cwd: expandHome(cwd.trim()) }));
      if (projects.length > 0) return projects;
    } catch {
      // 文件不存在或格式错误时退回到单项目
    }
    return [{ name: "default", cwd: this.fallbackCwd }];
  }

  /**
   * 这个范围当前所在的项目。
   * 话题第一次用到时继承所在群的当前项目并固定下来，之后群里再切换项目不会影响这个话题。
   * 没选过或原项目已被移除时，回到列表第一个。
   */
  current(scope: string): Project {
    const projects = this.list();
    const own = projects.find((p) => p.name === this.state.current[scope]);
    if (own) return own;
    const parent = parentScope(scope);
    if (parent === scope) return projects[0];
    const inherited = projects.find((p) => p.name === this.state.current[parent]) ?? projects[0];
    this.state.current[scope] = inherited.name;
    this.save();
    return inherited;
  }

  /** 按序号（从 1 开始）或名称切换。返回切换后的项目；找不到或目录不存在时返回错误说明。 */
  use(scope: string, target: string): Project | string {
    const projects = this.list();
    const index = /^\d+$/.test(target) ? Number(target) - 1 : -1;
    const project =
      projects[index] ?? projects.find((p) => p.name.toLowerCase() === target.toLowerCase());
    if (!project) return `没有叫「${target}」的项目。发 /use 查看可切换的列表。`;
    if (!existsSync(project.cwd)) return `项目「${project.name}」的目录不存在：${project.cwd}`;
    this.state.current[scope] = project.name;
    this.save();
    return project;
  }

  /**
   * 这个范围选用的 agent。
   * 和项目一样，话题第一次用到时继承所在群的选择并固定下来。
   */
  agent(scope: string): string {
    const own = this.state.agents[scope];
    if (own) return own;
    const parent = parentScope(scope);
    if (parent === scope) return this.defaultAgent();
    const inherited = this.state.agents[parent] ?? this.defaultAgent();
    this.state.agents[scope] = inherited;
    this.save();
    return inherited;
  }

  setAgent(scope: string, agent: string): void {
    this.state.agents[scope] = agent;
    this.save();
  }

  /** 会话是按 agent 分开存的；不指定 agent 时用这个范围当前选用的。 */
  private key(scope: string, project: Project, agent = this.agent(scope)): string {
    const base = `${scope}::${project.name}`;
    return agent === FIRST_AGENT ? base : `${base}::${agent}`;
  }

  getSession(scope: string, project: Project, agent?: string): string | undefined {
    return this.state.sessions[this.key(scope, project, agent)];
  }

  /** 记录当前会话，并更新历史。title 只在这个会话第一次出现时使用。 */
  setSession(scope: string, project: Project, sessionId: string, title = "", now = Date.now(), agent?: string): void {
    const key = this.key(scope, project, agent);
    this.state.sessions[key] = sessionId;
    const records = this.state.history[key] ?? [];
    const existing = records.find((r) => r.id === sessionId);
    const record: SessionRecord = existing
      ? { ...existing, lastUsedAt: now }
      : { id: sessionId, title: title.slice(0, 60), startedAt: now, lastUsedAt: now };
    this.state.history[key] = [record, ...records.filter((r) => r.id !== sessionId)].slice(0, MAX_HISTORY);
    this.save();
  }

  /** 开启新会话：只是不再续用当前的，历史记录保留，之后还能切回去。 */
  clearSession(scope: string, project: Project, agent?: string): void {
    delete this.state.sessions[this.key(scope, project, agent)];
    this.save();
  }

  /** 这个范围在这个项目里用过的会话，最近的在前。 */
  history(scope: string, project: Project): SessionRecord[] {
    return [...(this.state.history[this.key(scope, project)] ?? [])];
  }

  /** 按序号（从 1 开始）或会话 ID 切回历史里的一个会话。找不到时返回 undefined。 */
  resume(scope: string, project: Project, target: string): SessionRecord | undefined {
    const records = this.history(scope, project);
    const record = /^\d{1,2}$/.test(target) ? records[Number(target) - 1] : records.find((r) => r.id === target);
    if (!record) return undefined;
    this.state.sessions[this.key(scope, project)] = record.id;
    this.save();
    return record;
  }

  private loadState(): State {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch {
      return { current: {}, sessions: {}, history: {}, agents: {} };
    }
    const obj = (raw ?? {}) as Record<string, unknown>;
    if (typeof obj.sessions === "object" && obj.sessions !== null) {
      return {
        current: (obj.current as Record<string, string>) ?? {},
        sessions: obj.sessions as Record<string, string>,
        history: (obj.history as Record<string, SessionRecord[]>) ?? {},
        agents: (obj.agents as Record<string, string>) ?? {},
      };
    }
    // 旧格式：{ chat_id: session_id }。旧会话都是在 fallbackCwd 下建的，归到对应的项目名下。
    const legacyProject =
      this.list().find((p) => p.cwd === this.fallbackCwd)?.name ?? this.list()[0].name;
    const sessions: Record<string, string> = {};
    for (const [chatId, sessionId] of Object.entries(obj)) {
      if (typeof sessionId === "string") sessions[`${chatId}::${legacyProject}`] = sessionId;
    }
    return { current: {}, sessions, history: {}, agents: {} };
  }

  private save(): void {
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }
}
