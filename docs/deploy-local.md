# 本地生产环境部署指南

## 概述

本文档描述如何将 OpenClaw 部署到本地生产环境并通过系统服务管理。

## 前提条件

- macOS（使用 LaunchAgent）
- 已编译的代码：`/Volumes/D 1/code/openclaw/dist/`
- pnpm 和 node 已安装

## 快速开始

### 方式一：脚本部署（推荐用于开发）

```bash
cd /Volumes/D\ 1/code/openclaw
zsh scripts/deploy-local.sh 18789
```

### 方式二：手动部署

```bash
# 1. 停止现有进程
lsof -ti :18789 | xargs kill 2>/dev/null

# 2. 编译代码
cd /Volumes/D\ 1/code/openclaw
pnpm build && pnpm ui:build

# 3. 启动 Gateway
node dist/index.js gateway run --bind loopback --port 18789
```

## 系统服务部署（生产环境推荐）

### 安装服务

```bash
openclaw gateway install --port 18789
```

这会创建 LaunchAgent，服务将：

- 开机自启动
- 进程崩溃后自动重启
- 通过 `openclaw gateway` 命令管理

### 服务管理命令

```bash
# 启动服务
openclaw gateway start

# 停止服务
openclaw gateway stop

# 重启服务
openclaw gateway restart

# 查看状态
openclaw gateway status
```

## 代码更新流程

### 使用官方 restart 命令（推荐）

官方 `openclaw gateway restart` 会自动处理服务重启：

```bash
cd /Volumes/D\ 1/code/openclaw

# 1. 拉取最新代码
git pull origin main

# 2. 编译
pnpm build && pnpm ui:build

# 3. 重启服务（自动处理 SIGUSR1 / launchctl）
openclaw gateway restart --port 18789
```

### 使用脚本（简化版）

```bash
cd /Volumes/D\ 1/code/openclaw
zsh scripts/restart-gateway.sh
```

脚本内容：

```bash
#!/bin/zsh
set -e
PORT=${1:-18789}

# 1. 拉取最新代码
git pull origin main

# 2. 编译
pnpm build && pnpm ui:build

# 3. 重启服务
openclaw gateway restart --port $PORT
```

## 验证部署

```bash
# 检查 Gateway 状态
curl -s -o /dev/null -w "%{http_code}" http://localhost:18789/
# 预期输出：200

# 查看日志
openclaw logs
tail -f ~/.openclaw/logs/gateway.log
```

## 常见问题

### Q: `pnpm: command not found`

pnpm 通过 shell 函数加载，需要在 zsh 中运行：

```bash
zsh scripts/deploy-local.sh
```

### Q: `openclaw gateway stop` 显示 "Service not loaded"

服务未安装。使用方式一（脚本）或手动管理进程。

### Q: UI 显示 503 "Control UI assets not found"

UI 资源未构建。运行：

```bash
pnpm ui:build
```

### Q: 端口被占用

```bash
# 查看占用端口的进程
lsof -i :18789

# 强制终止
lsof -ti :18789 | xargs kill -9
```

## 服务配置说明

服务配置文件位于：

- `~/Library/LaunchAgents/ai.openclaw.gateway.plist`

关键配置：

- **工作目录**：`/Volumes/D 1/code/openclaw`
- **入口文件**：`dist/index.js gateway --port 18789`
- **日志文件**：`~/.openclaw/logs/gateway.log`

### Restart 机制说明

`openclaw gateway restart` 命令通过 launchd 重启服务：

1. **外部重启**（从终端手动执行）：直接调用 `launchctl kickstart -k <service-target>`
2. **内部重启**（OpenClaw 自身触发）：使用 detached handoff 机制避免进程在重启完成前被终止

重启后 launchd 自动使用更新后的 `dist/index.js`，无需重新 install。

## 环境变量

服务会自动设置以下环境变量：

- `HTTP_PROXY` / `HTTPS_PROXY`：代理设置
- `HOME`：用户目录
- `OPENCLAW_GATEWAY_PORT`：端口号
