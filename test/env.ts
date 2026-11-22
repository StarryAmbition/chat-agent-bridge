// 给需要加载整套模块的测试准备环境：假的凭证，以及一个临时的数据目录。
// 必须在导入 src 里的模块之前先导入这个文件。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dataDir = mkdtempSync(join(tmpdir(), "bridge-test-"));
export const projectA = join(dataDir, "proj-a");
export const projectB = join(dataDir, "proj-b");
mkdirSync(projectA);
mkdirSync(projectB);
writeFileSync(join(dataDir, "projects.json"), JSON.stringify({ alpha: projectA, beta: projectB }));

Object.assign(process.env, {
  LARK_APP_ID: "cli_0000000000000000",
  LARK_APP_SECRET: "test",
  LARK_DOMAIN: "lark",
  OWNER_OPEN_ID: "ou_owner",
  ALLOWED_CHAT_IDS: "oc_chat",
  ALLOWED_TOOLS: "Read,Glob,Grep,Edit,Write,Bash",
  BRIDGE_DATA_DIR: dataDir,
  NO_COLOR: "1",
});
delete process.env.AUTH_MODE;
