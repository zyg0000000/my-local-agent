# Claude 上下文指南 - 爬虫与自动化系统

## 项目概述

这是一个基于 Puppeteer 的星图数据爬虫系统，运行在火山引擎 ECS 上，与 AgentWorks 前端联动。

## 快速了解代码

请先阅读以下文件了解系统架构：

1. **入口文件**
   - `task-server.js` - HTTP 任务服务器，接收 AgentWorks 的任务请求
   - `local-agent.js` - 本地任务轮询代理

2. **核心执行器**
   - `puppeteer-executor.js` - Puppeteer 爬虫执行器
   - `workflow-loader.js` - 工作流加载器

3. **运维文档**
   - `ECS-操作说明.md` - 火山引擎 ECS 服务器操作指南（SSH、部署、日志查看等）

4. **开发计划**
   - `待办-开发计划.md` - 当前开发任务和技术方案

## 关键概念

- **Workflow**: AgentWorks 定义的自动化工作流，包含多个 Step
- **Task**: 单次执行任务，包含输入参数和执行状态
- **inputConfig**: 工作流输入配置（新格式），兼容旧的 requiredInput

## 相关项目

- **AgentWorks 前端**: `/Users/yigongzhang/字节专用程序/my-product-frontend/frontends/agentworks/`
- **云函数**: `/Users/yigongzhang/字节专用程序/my-product-frontend/functions/`

## 常用命令

```bash
# 启动任务服务器
node task-server.js

# 本地测试
node local-agent.js
```
