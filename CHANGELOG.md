# 更新记录

## v0.1.0（2026-11-22）

Chat Agent Bridge 的第一个公开版本。

在 Lark / 飞书的群聊里，指挥你自己电脑上的 Claude Code 和 Codex。

介绍页：https://www.starryambition.com/chat-agent-bridge

### 这个版本包含

- **配置向导**：`chat-agent-bridge init` 六步完成配置，在群里 @ 一下机器人就能确认主人
- **实时进度**：任务执行时用一张卡片显示每一步，结束后原地变成结果，可随时停止
- **危险操作审批**：删除文件、推送代码、安装软件、读取项目目录以外的文件，先在群里问你
- **多项目与多会话**：`/use` 切换项目，每个项目和每个话题有独立的会话，`/history` 可以切回旧会话
- **图片和文件**：可以发截图和文件给它，它生成的文件也会发回群里
- **定时任务**：`/schedule add 每天 09:00 <指令>`
- **两个 agent**：Claude Code 和 Codex，用 `/agent` 切换
- **后台服务**：`service install` 开机自启、崩溃自动恢复；睡眠或断网恢复后会提醒离线了多久
- **终端控制面板**：直接运行 `chat-agent-bridge` 用菜单修改所有配置
- **诊断、更新、卸载**：`doctor`、`update`、`uninstall`

### 安装

```bash
git clone https://github.com/StarryAmbition/chat-agent-bridge.git
cd chat-agent-bridge
npm install && npm run build && npm link
chat-agent-bridge init
```

需要 macOS、Node.js 20.6 或更高版本、一个 Claude 账号（订阅或 API key），以及能创建应用的 Lark 或飞书账号。

### 已知的限制

- 只在 macOS（Apple 芯片）和 Lark 国际版上实际验证过；飞书国内版用的是同一套代码，但没有实测
- 后台服务只支持 macOS
- 界面和文档目前只有中文
- Codex 没有逐条审批，靠它自带的沙箱限制
- 审批按命令文字判断，不是安全边界，详见 README 的「安全」一节
