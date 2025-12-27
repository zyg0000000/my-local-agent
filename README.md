# 截图套件 - 星图数据抓取自动化系统

基于 Puppeteer 的抖音星图平台数据抓取系统，支持本地执行和 ECS 云服务器部署。

---

## 当前状态

**执行环境决策中** - 详见 [ECS-本地技术差异分析.md](./ECS-本地技术差异分析.md)

| 环境 | 状态 | 说明 |
|------|------|------|
| **本地 Mac** | 稳定可用 | v22.0，住宅 IP，仅滑块验证 |
| **ECS 云服务器** | 问题排查中 | v23.0，机房 IP 被风控，滑块+手机验证 |

**推荐方案**：本地执行 + Cloudflare Tunnel 远程触发

---

## 快速开始

### 本地执行

```bash
cd /Users/yigongzhang/字节专用程序/截图套件

# 轮询模式（监听 MongoDB 任务队列）
npm run watch

# 或手动执行
node local-agent.js
```

### Cookie 刷新

```bash
# 登录并导出 Cookie（浏览器会打开，手动完成登录）
node refresh-cookie.js
```

---

## 核心文件

| 文件 | 说明 |
|------|------|
| `puppeteer-executor.js` | Puppeteer 核心执行器（本地 v22.0） |
| `local-agent.js` | 任务轮询代理 |
| `task-server.js` | HTTP API 服务（本地/ECS 共用） |
| `refresh-cookie.js` | Cookie 刷新脚本 |
| `user_data_agent/` | 浏览器状态缓存目录（登录态） |

---

## 文档索引

| 文档 | 内容 |
|------|------|
| [ECS-操作说明.md](./ECS-操作说明.md) | ECS 服务器运维手册（SSH、PM2、API） |
| [ECS-本地技术差异分析.md](./ECS-本地技术差异分析.md) | ECS vs 本地技术对比、问题诊断、决策建议 |
| [待办-开发计划.md](./待办-开发计划.md) | 开发计划、待办事项、架构决策 |
| [新对话-上下文提示词.md](./新对话-上下文提示词.md) | Claude 新对话上下文模板 |

---

## 相关项目

- **AgentWorks 前端**：`/Users/yigongzhang/字节专用程序/my-product-frontend/frontends/agentworks/`
- **云函数**：`/Users/yigongzhang/字节专用程序/my-product-frontend/functions/`
- **GitHub**：https://github.com/zyg0000000/my-local-agent.git

---

## ECS 服务器信息

| 配置 | 值 |
|------|-----|
| 公网 IP | `14.103.18.8` |
| API 端口 | `3001` |
| 项目目录 | `/opt/puppeteer-executor/` |
| SSH 登录 | `ssh root@14.103.18.8` |

详细操作见 [ECS-操作说明.md](./ECS-操作说明.md)
