// 合上盖子也保持运行：说明几种办法和代价。这里只读取系统状态，不替用户改任何系统设置。

import { execFileSync } from "node:child_process";
import { bold, command, dim, hint, ok, say, warn } from "./ui.js";

function pmset(args: string[]): string {
  try {
    return execFileSync("pmset", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

export function sleepDisabled(): boolean | undefined {
  const out = pmset(["-g"]);
  if (!out) return undefined;
  // 这一项只有被设置过才会出现在输出里；没有就是系统默认，即没有关闭睡眠
  return /SleepDisabled\s+1/.test(out);
}

export function runAwake(): void {
  if (process.platform !== "darwin") {
    say("这份说明只适用于 macOS。");
    return;
  }
  const disabled = sleepDisabled();
  const onBattery = /Battery Power/.test(pmset(["-g", "batt"]));

  say(bold("\n合上盖子时 bridge 还能不能响应\n"));
  say("后台服务运行期间，电脑不会因为闲置而休眠。但合上 MacBook 的盖子是另一回事：");
  say("系统默认会强制睡眠，这时 bridge 收不到消息，直到你再打开盖子。\n");

  say(bold("当前状态"));
  if (disabled === true) ok("系统睡眠已关闭：合上盖子也会继续运行。");
  else if (disabled === false) warn("系统睡眠是开启的：合上盖子后 bridge 会停止响应。");
  else say(dim("  读不到睡眠设置。"));
  say(`  电源：${onBattery ? "正在使用电池" : "已接电源"}\n`);

  say(bold("办法一：接电源和外接显示器（推荐）"));
  say("  接上电源、外接显示器和键盘鼠标后合盖，系统会继续运行。这是 macOS 自带的行为，");
  say("  不需要改任何设置，也没有副作用。\n");

  say(bold("办法二：关闭系统睡眠"));
  say("  不接显示器也能合盖运行。需要管理员密码，由你自己在终端执行：");
  command("sudo pmset -a disablesleep 1");
  say("  恢复原样：");
  command("sudo pmset -a disablesleep 0");
  warn("关闭睡眠后，合着盖子、没接电源放进包里，电脑会一直运行：发热，并把电池耗尽。");
  hint("只在电脑接着电源放在桌上的时候用，带出门之前记得恢复。");
  hint("这个设置对整台电脑生效，和 bridge 是否在运行无关。\n");

  say(bold("办法三：换一台不用合盖的机器"));
  say("  需要全天在线的话，放在一台 Mac mini 或者不合盖的旧电脑上更省心。\n");
}
