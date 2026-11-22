import { readFileSync, writeFileSync } from "node:fs";

export interface Member {
  id: string;
  name: string;
}

/**
 * 除主人以外，允许跟 Claude Code 对话的人。存成一个 JSON 文件，重启后保留。
 * 主人不在这份名单里：主人永远有权限，也不能被移除。
 */
export class Allowlist {
  private members: Member[];

  constructor(
    private readonly file: string,
    private readonly ownerId: string,
  ) {
    this.members = this.load();
  }

  list(): Member[] {
    return [...this.members];
  }

  has(id: string): boolean {
    return this.members.some((m) => m.id === id);
  }

  /** 返回 false 表示没有变化（已经在名单里，或者是主人本人）。 */
  add(member: Member): boolean {
    if (!member.id || member.id === this.ownerId || this.has(member.id)) return false;
    this.members.push({ id: member.id, name: member.name || member.id });
    this.save();
    return true;
  }

  /** 返回被移除的人；不在名单里时返回 undefined。 */
  remove(id: string): Member | undefined {
    const found = this.members.find((m) => m.id === id);
    if (!found) return undefined;
    this.members = this.members.filter((m) => m.id !== id);
    this.save();
    return found;
  }

  /** 名单文件被别处改了之后重新读取。返回有没有变化。 */
  reload(): boolean {
    const next = this.load();
    if (JSON.stringify(next) === JSON.stringify(this.members)) return false;
    this.members = next;
    return true;
  }

  private load(): Member[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(
          (m): m is Member =>
            typeof m === "object" && m !== null && typeof (m as Member).id === "string",
        )
        .filter((m) => m.id !== this.ownerId)
        .map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : m.id }));
    } catch {
      return [];
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.members, null, 2));
  }
}
