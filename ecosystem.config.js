/**
 * PM2 Ecosystem Configuration
 * 用于管理 ECS 上的爬虫服务
 *
 * 两种运行模式：
 * 1. puppeteer-agent: 轮询模式，监听 MongoDB 任务队列
 * 2. task-server: API 模式，提供 HTTP 接口按需执行
 *
 * 可以同时运行两者，也可以只运行其一
 */

module.exports = {
  apps: [
    // 轮询模式：监听 MongoDB 任务队列
    {
      name: 'puppeteer-agent',
      script: 'local-agent.js',
      args: '--watch',
      cwd: '/opt/puppeteer-executor',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      max_memory_restart: '1G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/opt/puppeteer-executor/logs/agent-error.log',
      out_file: '/opt/puppeteer-executor/logs/agent-out.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production'
      },
      watch: false,
      ignore_watch: ['node_modules', 'logs', '*.log', 'screenshots'],
      kill_timeout: 10000
    },

    // API 模式：HTTP 接口按需执行
    {
      name: 'task-server',
      script: 'task-server.js',
      cwd: '/opt/puppeteer-executor',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      max_memory_restart: '500M',  // API 服务器内存占用小
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/opt/puppeteer-executor/logs/api-error.log',
      out_file: '/opt/puppeteer-executor/logs/api-out.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        API_PORT: 3001
      },
      watch: false,
      kill_timeout: 10000
    },

    // 全局定时调度器：根据配置自动执行日报抓取
    {
      name: 'scheduler',
      script: 'scheduler.js',
      cwd: '/opt/puppeteer-executor',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      max_memory_restart: '200M',  // 调度器内存占用很小
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/opt/puppeteer-executor/logs/scheduler-error.log',
      out_file: '/opt/puppeteer-executor/logs/scheduler-out.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        TASK_SERVER_URL: 'http://localhost:3001'
      },
      watch: false,
      kill_timeout: 10000
    }
  ]
};
