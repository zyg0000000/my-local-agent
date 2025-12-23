# ECS 爬虫服务器操作手册

> 最后更新：2024-12-23

---

## 1. 快速参考

### 服务器信息

| 配置项 | 值 |
|--------|-----|
| 公网 IP | `14.103.18.8` |
| SSH 端口 | `22` |
| API 端口 | `3001` |
| 用户名 | `root` |
| 密码 | `64223902Kz` |
| 项目目录 | `/opt/puppeteer-executor/` |
| API 地址 | `http://14.103.18.8:3001` |

### 一键连接

```bash
# SSH 登录（需输入密码）
ssh root@14.103.18.8

# 免密登录（推荐）
sshpass -p '64223902Kz' ssh -o StrictHostKeyChecking=no root@14.103.18.8
```

---

## 2. 日常操作

### 2.1 状态检查

```bash
# 检查服务器状态
curl http://14.103.18.8:3001/api/status

# 检查 Cookie 状态（最重要）
curl http://14.103.18.8:3001/api/cookie-status

# 健康检查
curl http://14.103.18.8:3001/health

# 获取工作流列表
curl http://14.103.18.8:3001/api/workflows
```

### 2.2 Cookie 刷新

Cookie 过期后爬虫无法正常工作，需要刷新。

#### 方式 A：本地脚本一键刷新（推荐）

```bash
# 1. 进入脚本目录
cd /Users/yigongzhang/字节专用程序/截图套件

# 2. 运行登录脚本
node refresh-cookie.js

# 3. 在浏览器中完成登录
#    - 输入邮箱和密码
#    - 如果出现滑块验证，手动完成
#    - 登录后可在网站浏览验证无滑块问题
#    - 按 Enter 键确认导出

# 4. 脚本自动完成：
#    - 导出 Cookie 到 xingtu-cookies.json
#    - 通过 SCP 上传到 ECS
```

#### 方式 B：前端手动上传

1. 本地运行 `node refresh-cookie.js` 生成 Cookie 文件
2. 打开 AgentWorks → 自动化管理页面
3. 在「会话状态」卡片点击「上传 Cookie 文件」
4. 选择 `xingtu-cookies.json` 文件

#### 方式 C：手动 SCP 上传

```bash
sshpass -p '64223902Kz' scp -o StrictHostKeyChecking=no \
  /Users/yigongzhang/字节专用程序/截图套件/xingtu-cookies.json \
  root@14.103.18.8:/opt/puppeteer-executor/xingtu-cookies.json
```

---

## 3. 服务管理（PM2）

### 3.1 查看状态

```bash
pm2 list          # 查看所有服务
pm2 status        # 同上
pm2 monit         # 实时监控面板
```

### 3.2 日志查看

```bash
pm2 logs task-server              # 查看 task-server 日志
pm2 logs task-server --lines 50   # 查看最近 50 行
pm2 logs task-server --lines 100  # 查看最近 100 行
```

### 3.3 服务控制

```bash
# 重启（最常用）
pm2 restart task-server
pm2 restart all

# 停止
pm2 stop task-server
pm2 stop all

# 启动
pm2 start task-server
pm2 start all

# 删除（从 PM2 列表移除）
pm2 delete task-server
pm2 delete all
```

### 3.4 首次部署

```bash
cd /opt/puppeteer-executor

# 启动 HTTP API 服务
pm2 start task-server.js --name task-server

# 保存配置（开机自启）
pm2 save
pm2 startup
```

---

## 4. API 接口

基础地址：`http://14.103.18.8:3001`

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/status` | 服务器状态（运行时间、内存） |
| GET | `/api/cookie-status` | Cookie 状态（有效期） |
| GET | `/api/workflows` | 获取工作流列表 |
| POST | `/api/task/execute` | 执行单个任务 |
| POST | `/api/task/batch` | 批量执行任务（最多10个） |
| POST | `/api/cookie/upload` | 上传新 Cookie |
| GET | `/health` | 健康检查 |

### 执行任务示例

```bash
# 执行单个任务
curl -X POST http://14.103.18.8:3001/api/task/execute \
  -H "Content-Type: application/json" \
  -d '{"workflowId": "xxx", "inputValue": "12345"}'
```

---

## 5. 代码部署

### 5.1 上传 task-server.js

```bash
# 上传文件
sshpass -p '64223902Kz' scp -o StrictHostKeyChecking=no \
  /Users/yigongzhang/字节专用程序/截图套件/task-server.js \
  root@14.103.18.8:/opt/puppeteer-executor/

# 重启服务
sshpass -p '64223902Kz' ssh -o StrictHostKeyChecking=no root@14.103.18.8 \
  "pm2 restart task-server"
```

### 5.2 上传 puppeteer-executor.js

```bash
# 上传文件
sshpass -p '64223902Kz' scp -o StrictHostKeyChecking=no \
  /Users/yigongzhang/字节专用程序/截图套件/puppeteer-executor.js \
  root@14.103.18.8:/opt/puppeteer-executor/

# 重启服务
sshpass -p '64223902Kz' ssh -o StrictHostKeyChecking=no root@14.103.18.8 \
  "pm2 restart task-server"
```

### 5.3 一键部署脚本

```bash
# 上传并重启
sshpass -p '64223902Kz' scp -o StrictHostKeyChecking=no \
  /Users/yigongzhang/字节专用程序/截图套件/task-server.js \
  root@14.103.18.8:/opt/puppeteer-executor/ && \
sshpass -p '64223902Kz' ssh -o StrictHostKeyChecking=no root@14.103.18.8 \
  "pm2 restart task-server && pm2 logs task-server --lines 5"
```

---

## 6. 调试排查

### 6.1 手动执行爬虫（调试用）

```bash
# SSH 登录后
cd /opt/puppeteer-executor

# 先停止 PM2 服务（避免冲突）
pm2 stop all

# 方式A：使用 local-agent.js（轮询模式）
node local-agent.js --watch
# - 会轮询 MongoDB 中的任务队列
# - --watch 模式会在文件变化时自动重启
# - 按 Enter 键开始执行任务

# 方式B：直接运行 puppeteer-executor
node puppeteer-executor.js              # 单次执行
node --watch puppeteer-executor.js      # watch 模式

# 完成后记得重启 PM2 服务
pm2 start task-server
```

### 6.2 常见问题

#### 服务器无法连接

```bash
# 本地测试端口是否开放
nc -zv 14.103.18.8 3001

# 检查防火墙状态（在 ECS 上）
ufw status
iptables -L -n
```

#### Cookie 过期

```bash
# 检查状态
curl http://14.103.18.8:3001/api/cookie-status

# 如果 valid: false，运行本地刷新脚本
cd /Users/yigongzhang/字节专用程序/截图套件
node refresh-cookie.js
```

#### 工作流执行失败

```bash
# 查看详细日志
sshpass -p '64223902Kz' ssh root@14.103.18.8 "pm2 logs task-server --lines 100"
```

#### 内存不足

```bash
# 检查内存使用
sshpass -p '64223902Kz' ssh root@14.103.18.8 "free -h"

# 重启服务释放内存
sshpass -p '64223902Kz' ssh root@14.103.18.8 "pm2 restart all"
```

---

## 7. 参考信息

### 7.1 文件目录结构

#### ECS 服务器

```
/opt/puppeteer-executor/
├── task-server.js         # HTTP API 服务（PM2 运行）
├── puppeteer-executor.js  # 核心执行器
├── local-agent.js         # 轮询模式代理（调试用）
├── xingtu-cookies.json    # 登录 Cookie
├── .env                   # 环境变量配置
├── package.json
└── node_modules/
```

#### 本地 Mac

```
/Users/yigongzhang/字节专用程序/截图套件/
├── refresh-cookie.js      # Cookie 刷新脚本（本地运行）
├── puppeteer-executor.js  # 本地副本
├── task-server.js         # 本地副本
├── xingtu-cookies.json    # 导出的 Cookie（临时）
├── ECS-操作说明.md        # 本文档
└── package.json
```

### 7.2 环境变量（ECS .env 文件）

```bash
# MongoDB 连接
MONGO_URI=mongodb+srv://...

# 数据库名
DB_NAME=kol_data

# API 端口
API_PORT=3001

# TOS 对象存储（截图上传）
TOS_ACCESS_KEY_ID=xxx
TOS_SECRET_ACCESS_KEY=xxx
TOS_ENDPOINT=tos-cn-shanghai.volces.com
TOS_BUCKET_NAME=automation-suite-screenshots
```

查看环境变量：

```bash
sshpass -p '64223902Kz' ssh root@14.103.18.8 "cat /opt/puppeteer-executor/.env"
```

---

## 8. 待开发功能

- [ ] 滑块验证检测与超级鹰自动解决
- [ ] 执行失败自动重试
- [ ] 飞书/邮件告警通知
