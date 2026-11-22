# Chat Agent Bridge

在聊天软件的群里，指挥你电脑上的编程 agent。

目前支持的聊天平台是 Lark 和飞书，agent 有 Claude Code 和 Codex（在群里用 `/agent` 切换）。

你在群里发一句话，Claude Code 就在这台电脑的项目目录里读代码、改文件、运行命令，把过程和结果发回群里。群里的其他人能看到，但只有你能指挥。

```
你在群里 @机器人 ──> Lark ──(长连接)──> bridge（你的电脑）──> Claude Code
                                              │
你在群里看到进度和结果 <──────────────────────┘
```

不需要公网 IP，也不需要服务器：bridge 主动连到 Lark，所有东西都跑在你自己的电脑上。

## 需要准备什么

- 一台 Mac，装有 Node.js 20.6 或更高版本
- 一个 Claude 账号（Pro 或 Max 订阅），或者一个 Anthropic API key
- 一个 Lark 或飞书账号，并且有权限在所在的企业里创建应用

## 安装

```bash
npm install -g chat-agent-bridge
```

想从源码安装的话：

```bash
git clone https://github.com/StarryAmbition/chat-agent-bridge.git
cd chat-agent-bridge
npm install
npm run build
npm link
```

装好后终端里就有了 `chat-agent-bridge` 命令（也可以用简写 `cab`）。

## 开始使用

```bash
chat-agent-bridge init
```

向导会一步步带你完成：

1. **Claude**：检查这台电脑是否已登录 Claude Code，没有的话当场登录。
2. **机器人应用**：用手机扫码创建，或者按清单在开发者后台手动创建。
3. **确认主人**：把机器人拉进群，@ 它说一句话。向导认出你之后，你就是唯一能指挥它的人。
4. **项目目录**：告诉它 Claude 可以在哪些目录里工作。
5. **权限**：只读、可以改文件、可以改文件并运行命令，三选一。

然后启动：

```bash
chat-agent-bridge start
```

在群里 @机器人 说话就可以了。只 @ 不说话，会显示全部聊天命令。

## 启动之后修改配置

bridge 运行的时候，另开一个终端窗口，直接运行：

```bash
chat-agent-bridge
```

会进入控制面板，用菜单管理所有内容：启动与后台服务、项目目录、权限档位、聊天设置、白名单、限定的群、Claude 调用方式，以及重新配置机器人应用和主人。

也可以用单条命令直接改：

| 命令 | 作用 |
|---|---|
| `chat-agent-bridge status` | 是否在运行，以及当前配置概况 |
| `chat-agent-bridge project add <目录> [名字]` | 添加项目 |
| `chat-agent-bridge project remove <名字>` | 删除项目（只是从列表里去掉） |
| `chat-agent-bridge set` | 列出所有设置项和当前值 |
| `chat-agent-bridge set interval 30` | 两条命令之间至少间隔 30 秒 |
| `chat-agent-bridge set follow off` | 关闭持续对话 |
| `chat-agent-bridge set approve on` | 开启危险操作审批 |
| `chat-agent-bridge set model default` | 用默认模型 |
| `chat-agent-bridge set permission edit` | 权限档位：`readonly` / `edit` / `full` |
| `chat-agent-bridge allow add <open_id> [名字]` | 加入白名单 |
| `chat-agent-bridge allow remove <名字>` | 移出白名单 |

项目、聊天设置和白名单改完后，运行中的 bridge 会在几秒内自动读到。权限档位、限定的群、调用方式和应用凭证要重启才生效，改的时候会提示。

## 一直在后台运行

```bash
chat-agent-bridge service install
```

装成后台服务之后：开机自动启动，崩溃了自动恢复，运行期间电脑不会因为闲置而休眠。

| 命令 | 作用 |
|---|---|
| `chat-agent-bridge service status` | 是否在运行 |
| `chat-agent-bridge service logs` | 查看日志 |
| `chat-agent-bridge service restart` | 重启 |
| `chat-agent-bridge service uninstall` | 停止并移除 |

**合上盖子的情况**：MacBook 合盖后系统会强制睡眠，bridge 也就停了。运行下面的命令查看几种办法和各自的代价：

```bash
chat-agent-bridge awake
```

**睡眠和断网之后**：电脑睡眠再唤醒、网络断开再恢复，bridge 会自己重新连上。离线期间发给它的消息不会补发，所以离线超过两分钟时，它恢复后会在群里说一声离线了多久，提醒你重发。

## 更新和卸载

| 命令 | 作用 |
|---|---|
| `chat-agent-bridge version` | 当前版本 |
| `chat-agent-bridge update` | 更新到最新版本，并重启后台服务 |
| `chat-agent-bridge uninstall` | 移除后台服务；配置和数据要不要删会单独问你 |

后台服务的日志超过 5 MB 时会自动轮转，只保留一份备份。

## 出了问题

```bash
chat-agent-bridge doctor
```

它会逐项检查：Claude 是否登录、应用凭证和域名是否正确、机器人是否在群里、项目目录是否存在、有没有别的程序在抢同一个机器人的消息，并告诉你每一项怎么修。

几个常见现象：

| 现象 | 多半是因为 |
|---|---|
| 机器人完全不回消息 | 开发者后台没有用长连接订阅 `im.message.receive_v1`，或者改动后没有发布新版本 |
| 时灵时不灵 | 有两个程序在用同一个应用，Lark 只会把每条消息发给其中一个 |
| 卡片上的按钮点了没反应 | 没有订阅回调 `card.action.trigger` |
| 发图片或文件失败 | 应用缺少 `im:resource` 权限 |
| 提示域名错误 | 国内版飞书和国际版 Lark 的应用互不相通，`init` 和 `doctor` 会自动识别 |

## 在群里能做什么

| 命令 | 作用 |
|---|---|
| `/use` | 列出、切换项目。每个项目有独立的会话，不同项目的任务可以同时进行 |
| `/new` | 在当前项目开启新会话 |
| `/history` | 列出用过的会话，可以切回去 |
| `/stop` | 停止正在执行的任务 |
| `/status` | 正在执行的任务、排队情况、会话上下文占用 |
| `/compact` | 压缩当前会话 |
| `/schedule` | 定时任务，例如 `/schedule add 每天 09:00 检查有没有未提交的改动` |
| `/usage` | 订阅用量和重置时间 |
| `/agent` | 在 Claude Code 和 Codex 之间切换，每个群（或话题）各选各的 |
| `/model` | 切换当前 agent 用的模型 |
| `/host` | 这台电脑的 CPU、内存、磁盘、电量 |
| `/setting` | 持续对话、命令间隔、危险操作审批 |
| `/allow` | 管理白名单 |
| `/approve` `/deny` | 批准或拒绝等待中的危险操作 |
| `/restart` | 重启 bridge（需要以后台服务方式运行） |
| `/about` | 功能介绍 |

还可以：

- **直接发图片和文件**，比如一张报错截图。
- **让它把文件发回来**：Claude 生成的 PDF、图片、表格会直接发到群里。
- **用话题并行**：在群里以话题形式回复，每个话题是一个独立的会话。
- **持续对话**：@ 过一次之后不用每句都 @，直到你 @ 了别人，或者空闲超过设定的时间。

## 用 Codex

在群里发 `/agent codex` 就切换到 Codex，发 `/agent claude` 切回来。要求这台电脑上的 Codex 已经登录过（装过 Codex 应用或命令行并登录即可，bridge 用的是同一份登录）。

- 每个 agent 有自己独立的会话，切换后再切回来，原来的会话还在。
- 进度卡片、图片输入、把文件发回群里、`/new`、`/history`、`/stop` 都可以用。
- `/compact` 和 `/usage` 只对 Claude Code 有效。
- 想让新的群默认用 Codex：`chat-agent-bridge set agent codex`。

**权限上的区别，请务必了解**：Codex 在这里没有"危险操作先发卡片审批"这一层，靠的是它自带的沙箱。

| 权限档位 | Claude Code | Codex |
|---|---|---|
| 只读 | 只能看和搜索 | 沙箱只读，可以运行只读的命令 |
| 可以改文件 | 能改文件，不能运行命令 | 只能写项目目录，不能联网，**可以在沙箱里运行命令** |
| 可以改文件并运行命令 | 危险操作先审批 | 只能写项目目录，可以联网，**没有审批** |

也就是说，在最高一档下，Codex 可以不经询问就在项目目录里删除文件、访问网络。沙箱的具体边界由 Codex 自己决定，bridge 不做额外检查。

## 安全

bridge 做的事情是把聊天消息变成你电脑上的操作，请认真对待：

- **只有主人能指挥**。其他人的消息会被忽略。
- **默认只读**。要让它改文件或运行命令，需要在向导里明确选择。
- **只读项目目录**。Claude Code 读文件、搜索都限制在当前项目目录里（外加临时文件和你发给它的附件）。要读别处的文件会先在群里问你；审批关闭时直接拒绝。项目里指向外面的符号链接也算外面。
- **危险操作先审批**。删除文件、推送或改写 git 历史、安装软件、发布部署、结束进程、读取 `~/.ssh` 这类存放密钥和登录凭证的位置，以及修改项目目录以外的文件，会先在群里发卡片，你批准后才执行，10 分钟不处理自动拒绝。
- **审批不是安全边界**。它按命令的文字来判断，能拦住直接写出来的危险命令，拦不住藏在脚本文件里的操作。一旦允许运行命令，命令能读到的文件就不止项目目录了，上面"只读项目目录"的限制只对读文件和搜索这两类操作是严格的。不要让它在你不信任的代码仓库里运行命令。
- **Codex 的读取不受这个限制**。Codex 的沙箱限制的是写，不限制读。
- **定时任务无人值守**。遇到需要审批的操作会等待，没人处理就自动拒绝。
- 应用密钥保存在 `~/.chat-agent-bridge/config.json`，文件权限只允许你本人读取。

## 关于 Claude 订阅

用订阅登录时，bridge 调用的是你自己电脑上已登录的 Claude Code。Claude 的订阅只限账号持有人本人使用，所以在这个模式下**只有主人能指挥机器人**，白名单里的其他人不会被执行。

如果需要让其他人也能指挥，请在向导里选择 API key 方式。

## 数据放在哪里

所有配置和数据都在 `~/.chat-agent-bridge/`：

| 文件 | 内容 |
|---|---|
| `config.json` | 应用凭证、主人、权限档位 |
| `projects.json` | 项目列表，可以直接编辑，不用重启 |
| `settings.json` | 在群里用 `/setting` 修改的设置 |
| `state.json` | 各项目的会话和历史 |
| `schedules.json` | 定时任务 |
| `allowlist.json` | 白名单 |
| `inbox/` | 收到的图片和文件，7 天后自动清理 |
| `logs/` | 后台服务的日志 |

用环境变量 `BRIDGE_DATA_DIR` 可以换到别的目录。

## 手动创建应用时要开通的内容

选择扫码创建时这些会自动配置。手动创建的话，在开发者后台（Lark：`open.larksuite.com/app`，飞书：`open.feishu.cn/app`）按下面配置，**每次改动后都要创建版本并发布**。

权限：

| 权限 | 用途 |
|---|---|
| `im:message` | 读取与发送消息 |
| `im:message:send_as_bot` | 以机器人身份发消息 |
| `im:message.group_at_msg:readonly` | 接收群里 @机器人 的消息 |
| `im:message.group_msg` | 接收群里的所有消息（持续对话需要） |
| `im:message.p2p_msg:readonly` | 接收单聊消息 |
| `im:resource` | 读取和上传图片、文件 |
| `im:chat:readonly` | 读取群信息和群成员 |

事件与回调，订阅方式都选「长连接」：

| 类型 | 名称 |
|---|---|
| 事件 | `im.message.receive_v1` |
| 回调 | `card.action.trigger` |

长连接方式要求 bridge 先连上，后台才允许保存，所以向导把这一步放在了第 3 步。

## 开发

```bash
npm run cli -- <命令>   # 不编译，直接运行命令行
npm test                # 运行测试
npm run build           # 编译到 dist/
```

| 文件 | 职责 |
|---|---|
| `src/cli.ts` `src/cli/` | 命令行：配置向导、控制面板、诊断、后台服务、合盖说明 |
| `src/index.ts` | bridge 入口：接收 Lark 事件，检查权限后分发 |
| `src/commands.ts` | 聊天里的斜杠命令和卡片按钮 |
| `src/views.ts` | 各个界面的卡片 |
| `src/jobs.ts` | 任务排队与执行、进度卡片 |
| `src/agents/` | agent 接口，以及 Claude Code 和 Codex 两个实现 |
| `src/approvals.ts` | 危险操作审批 |
| `src/files.ts` `src/incoming.ts` | 发文件到群里；解析收到的消息和附件 |
| `src/schedule.ts` `src/scheduler.ts` | 定时规则；任务的保存和触发 |
| `src/usage.ts` `src/host.ts` | 订阅用量；宿主机状态 |
| `src/settings.ts` `src/gating.ts` | 设置；命令间隔和持续对话 |
| `src/chat.ts` `src/cards.ts` | 收发消息的统一入口；卡片基础组件 |
| `src/platforms/` | 聊天平台接口，以及 Lark / 飞书的实现 |
| `src/config.ts` `src/state.ts` | 配置；项目、会话、白名单 |
| `src/tools.ts` `src/log.ts` | 风险判断等纯函数；终端日志 |

测试会把数据目录指到临时目录，不会碰真实的配置和会话。

### 接入一个新的聊天平台

bridge 只通过 `src/platforms/types.ts` 里的 `Platform` 接口收发消息。一个平台要实现：

| 方法 | 作用 |
|---|---|
| `start(handlers)` | 连接平台；收到消息时整理成统一的 `ChatMessage` 交给 `handlers.message` |
| `replyText` `replyMarkdown` | 回复一条消息 |
| `sendText` | 往群里主动发消息 |
| `download` `replyFile` | 下载用户发来的附件；把本机文件发出去 |
| `members` | 群成员列表，查不到可以返回空 |
| `replyCard` `sendCard` `patchCard` | 可选。平台支持带按钮、可更新的卡片时才实现 |

`features` 里声明两项能力：`cards`（能不能发卡片）和 `ambient`（群里不 @ 的消息收不收得到）。不支持卡片时，bridge 会自动改用每张卡片的文字版，并提示用斜杠命令。

目前只有 Lark / 飞书一个实现（`lark.ts`）。要接新平台：在 `src/platforms/` 里实现 `Platform`，在 `src/platforms/index.ts` 里按配置选择，再在配置向导 `src/cli/init.ts` 里加上这个平台的创建步骤。

### 接入一个新的 agent

bridge 只通过 `src/agents/types.ts` 里的 `Agent` 接口跟 agent 打交道：

```ts
export interface Agent {
  id: string;        // 聊天命令里写的名字：/agent <id>
  name: string;      // 显示给人看的名字
  note: string;      // 切换卡片里的一句说明
  features: { approvals: boolean; compact: boolean };
  model(): string;   // 现在用的模型，空字符串表示默认
  run(task: AgentTask, hooks: AgentHooks): Promise<string>;
}
```

`run` 拿到任务（项目目录、指令内容、停止信号、要续上的会话 ID），执行过程中通过 `hooks` 报告进展，最后返回回复文字：

| 钩子 | 什么时候调用 |
|---|---|
| `session(id)` | 拿到会话 ID，下一条指令会带着它续上 |
| `step(text)` | 做了一步操作，显示在进度卡片里 |
| `draft(text)` | 正在写的回复，传到目前为止的全文 |
| `context(tokens, window?)` | 会话占用的上下文 |
| `limit(hit)` | 额度用完 |

步骤：

1. 在 `src/agents/` 里新建一个文件实现 `Agent`，可以参照 `codex.ts`（约 170 行）。
2. 在 `src/agents/index.ts` 的 `allAgents()` 里加上它。
3. 在 `src/cli/manage.ts` 的 `AGENT_IDS` 里加上它的 `id`（有测试检查两处一致）。

排队、进度卡片、会话的保存和切换、`/agent` 的卡片都不用改。

## 许可证

[MIT](LICENSE)
