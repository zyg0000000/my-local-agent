/**
 * @file task-server.js
 * @description HTTP API 服务器，提供按需执行工作流的能力
 * @version 3.0.0 - 双模式支持（同步 + 异步 VNC）
 *
 * 运行方式: pm2 start task-server.js --name task-server
 *
 * v3.0 变更：
 * - [双模式] 非 VNC 模式：同步执行，等待完成后返回结果
 * - [双模式] VNC 模式：异步执行，通过 SSE 获取进度
 * - [VNC] 支持验证码手动处理暂停/恢复
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const os = require('os');
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');

// 引入 puppeteer-executor 的核心功能
const { executeActions, executeActionsWithProgress } = require('./puppeteer-executor');

const app = express();
app.use(cors());
app.use(express.json());

// 配置
const PORT = process.env.API_PORT || 3001;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'kol_data';
const COOKIE_FILE = path.join(__dirname, 'xingtu-cookies.json');

// 数据库连接
let db = null;

// ========== SSE 进度存储（仅 VNC 模式使用） ==========
const taskProgress = new Map();

// ========== 暂停任务存储（用于验证码手动处理） ==========
const pausedTasks = new Map();  // taskId -> { resolve, page, workflow }

/**
 * 初始化数据库连接
 */
async function initDB() {
    if (db) return db;
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('[DB] 成功连接到 MongoDB');
    return db;
}

/**
 * 获取所有可用工作流
 */
app.get('/api/workflows', async (req, res) => {
    try {
        await initDB();
        // isActive 可能是 true 或 undefined（未设置），都视为活跃
        const workflows = await db.collection('automation-workflows')
            .find({ isActive: { $ne: false } })
            .project({
                _id: 1,
                name: 1,
                requiredInput: 1,
                description: 1,
                enableVNC: 1
            })
            .toArray();

        // 转换格式
        const result = workflows.map(w => ({
            id: w._id.toString(),
            name: w.name,
            requiredInput: w.requiredInput?.key || 'xingtuId',
            inputLabel: w.requiredInput?.label || '星图 ID',
            description: w.description || '',
            enableVNC: w.enableVNC || false
        }));

        res.json(result);
    } catch (err) {
        console.error('[API] 获取工作流失败:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * SSE 端点 - 实时获取任务进度（仅 VNC 模式使用）
 */
app.get('/api/task/stream/:taskId', (req, res) => {
    const { taskId } = req.params;

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    console.log(`[SSE] 客户端订阅任务进度: ${taskId}`);

    // 发送当前状态
    const sendProgress = () => {
        const progress = taskProgress.get(taskId);
        if (progress) {
            res.write(`data: ${JSON.stringify(progress)}\n\n`);
        }
    };

    // 初始发送
    sendProgress();

    // 定期检查更新（500ms）
    const interval = setInterval(sendProgress, 500);

    // 客户端断开时清理
    req.on('close', () => {
        console.log(`[SSE] 客户端断开: ${taskId}`);
        clearInterval(interval);
    });
});

/**
 * 执行工作流（双模式支持）
 *
 * 模式判断：
 * - enableVNC=true（请求参数或工作流配置）：异步模式，通过 SSE 获取进度
 * - 其他情况：同步模式，等待执行完成后返回结果
 */
app.post('/api/task/execute', async (req, res) => {
    const { workflowId, inputValue, enableVNC, metadata } = req.body;

    if (!workflowId || !inputValue) {
        return res.status(400).json({
            success: false,
            error: '缺少必要参数: workflowId 和 inputValue'
        });
    }

    console.log(`[API] 收到执行请求: workflow=${workflowId}, input=${inputValue}, enableVNC=${enableVNC}`);

    try {
        await initDB();

        // 获取工作流定义
        const workflow = await db.collection('automation-workflows').findOne({
            _id: new ObjectId(workflowId)
        });

        if (!workflow) {
            return res.status(404).json({
                success: false,
                error: '工作流不存在'
            });
        }

        // 判断是否使用 VNC 模式（请求参数优先，否则使用工作流配置）
        const useVNC = enableVNC === true || (enableVNC === undefined && workflow.enableVNC === true);

        // 构建任务对象
        const inputKey = workflow.inputConfig?.key || workflow.requiredInput?.key || 'xingtuId';
        const task = {
            _id: new ObjectId(),
            [inputKey]: inputValue,
            workflowName: workflow.name,
            metadata: metadata || {},
            createdAt: new Date()
        };

        const taskId = task._id.toString();
        const totalSteps = workflow.steps ? workflow.steps.length : 0;

        // ========== VNC 模式：异步执行 ==========
        if (useVNC) {
            console.log(`[API] VNC 模式：异步执行工作流: ${workflow.name}`);

            // 设置全局 VNC 模式标志
            global.enableVNCMode = true;

            // 启动 VNC 服务
            try {
                const { startVNC } = require('./vnc-manager');
                await startVNC();
                console.log('[API] VNC 模式已启用');
            } catch (e) {
                console.log('[API] 启动 VNC 失败:', e.message);
            }

            // 初始化进度状态
            taskProgress.set(taskId, {
                taskId,
                status: "running",
                currentStep: 0,
                totalSteps,
                currentAction: "准备中...",
            });

            // 立即返回 taskId，前端通过 SSE 获取进度
            res.json({
                success: true,
                workflowId,
                workflowName: workflow.name,
                inputValue,
                taskId,
                async: true,
                message: "任务已提交，请通过 SSE 获取进度"
            });

            // 后台异步执行
            const startTime = Date.now();

            // 进度回调
            const onProgress = (progress) => {
                taskProgress.set(taskId, { taskId, ...progress });
            };

            // 暂停通知回调（验证码需要手动处理时）
            const onPause = (tid, pauseInfo) => {
                console.log('[SSE] 推送暂停状态:', tid, pauseInfo);
                taskProgress.set(tid, { taskId: tid, ...pauseInfo });

                return new Promise((resolve) => {
                    pausedTasks.set(tid, {
                        resolve,
                        page: null,
                        workflow
                    });
                });
            };

            (async () => {
                try {
                    let results;
                    if (typeof executeActionsWithProgress === "function") {
                        results = await executeActionsWithProgress(task, workflow, onProgress, onPause);
                    } else {
                        results = await executeActions(task, workflow);
                    }

                    const duration = Date.now() - startTime;
                    console.log(`[API] 工作流执行完成，耗时 ${duration}ms`);

                    // 关闭 VNC
                    if (global.enableVNCMode) {
                        try {
                            const { stopVNC } = require('./vnc-manager');
                            await stopVNC();
                            console.log('[API] 任务完成，VNC 已关闭');
                            global.enableVNCMode = false;
                        } catch (e) {
                            console.log('[API] 关闭 VNC 失败:', e.message);
                        }
                    }

                    // 更新最终状态
                    console.log(`[SSE] 推送最终状态: taskId=${taskId}, status=${results.status === "failed" ? "failed" : "completed"}`);
                    taskProgress.set(taskId, {
                        taskId,
                        status: results.status === "failed" ? "failed" : "completed",
                        result: results,
                        duration,
                    });
                } catch (err) {
                    console.error(`[API] 异步执行失败: ${err.message}`);

                    if (global.enableVNCMode) {
                        try {
                            const { stopVNC } = require('./vnc-manager');
                            await stopVNC();
                            global.enableVNCMode = false;
                        } catch (e) { /* ignore */ }
                    }

                    taskProgress.set(taskId, {
                        taskId,
                        status: "failed",
                        error: err.message,
                    });
                }

                // 5分钟后清理进度数据
                setTimeout(() => {
                    taskProgress.delete(taskId);
                    console.log(`[SSE] 清理进度数据: ${taskId}`);
                }, 5 * 60 * 1000);
            })();

            return; // VNC 模式已响应，不再继续
        }

        // ========== 非 VNC 模式：同步执行 ==========
        console.log(`[API] 同步模式：执行工作流: ${workflow.name}`);
        global.enableVNCMode = false;

        const startTime = Date.now();
        const results = await executeActions(task, workflow);
        const duration = Date.now() - startTime;

        console.log(`[API] 工作流执行完成，耗时 ${duration}ms`);

        res.json({
            success: true,
            workflowId,
            workflowName: workflow.name,
            inputValue,
            taskId,
            duration,
            results
        });

    } catch (err) {
        console.error('[API] 执行失败:', err);
        res.status(500).json({
            success: false,
            error: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
});

/**
 * 批量执行工作流（串行执行）
 * 注意：每个任务都会单独启动浏览器，适合小批量任务
 * 大批量任务建议使用 local-agent.js 的队列模式
 */
app.post('/api/task/batch', async (req, res) => {
    const { workflowId, inputValues, metadata } = req.body;

    if (!workflowId || !inputValues || !Array.isArray(inputValues)) {
        return res.status(400).json({
            success: false,
            error: '缺少必要参数: workflowId 和 inputValues 数组'
        });
    }

    // 限制批量大小，避免资源耗尽
    const MAX_BATCH_SIZE = 10;
    if (inputValues.length > MAX_BATCH_SIZE) {
        return res.status(400).json({
            success: false,
            error: `批量大小超过限制 (最大 ${MAX_BATCH_SIZE})`
        });
    }

    console.log(`[API] 收到批量执行请求: workflow=${workflowId}, count=${inputValues.length}`);

    const results = [];

    try {
        await initDB();

        const workflow = await db.collection('automation-workflows').findOne({
            _id: new ObjectId(workflowId)
        });

        if (!workflow) {
            return res.status(404).json({ success: false, error: '工作流不存在' });
        }

        const inputKey = workflow.requiredInput?.key || 'xingtuId';

        // 串行执行每个任务
        for (const inputValue of inputValues) {
            try {
                const task = {
                    _id: new ObjectId(),
                    [inputKey]: inputValue,
                    workflowName: workflow.name,
                    metadata: metadata || {},
                    createdAt: new Date()
                };

                const result = await executeActions(task, workflow);
                results.push({
                    inputValue,
                    success: true,
                    taskId: task._id.toString(),
                    result
                });

            } catch (err) {
                results.push({
                    inputValue,
                    success: false,
                    error: err.message
                });
            }
        }

        res.json({
            success: true,
            workflowId,
            workflowName: workflow.name,
            totalCount: inputValues.length,
            successCount: results.filter(r => r.success).length,
            results
        });

    } catch (err) {
        console.error('[API] 批量执行失败:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 检查 Cookie 状态
 */
app.get('/api/cookie-status', async (req, res) => {
    try {
        if (!fs.existsSync(COOKIE_FILE)) {
            return res.json({ valid: false, reason: 'no_cookie_file' });
        }

        const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
        const sessionCookie = cookies.find(c =>
            c.name === 'sessionid' || c.name === 'passport_csrf_token'
        );

        if (!sessionCookie) {
            return res.json({ valid: false, reason: 'no_session_cookie' });
        }

        // 检查过期时间
        const expiresAt = sessionCookie.expires * 1000;
        const now = Date.now();
        const daysUntilExpiry = (expiresAt - now) / (1000 * 60 * 60 * 24);

        res.json({
            valid: daysUntilExpiry > 0,
            expiresAt: new Date(expiresAt).toISOString(),
            daysUntilExpiry: Math.floor(daysUntilExpiry),
            warning: daysUntilExpiry < 3 && daysUntilExpiry > 0,
            cookieCount: cookies.length
        });
    } catch (err) {
        res.json({ valid: false, reason: 'error', error: err.message });
    }
});

/**
 * 服务器状态
 */
app.get('/api/status', (req, res) => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    res.json({
        status: 'running',
        uptime: process.uptime(),
        memory: {
            used: parseFloat((usedMem / 1024 / 1024 / 1024).toFixed(1)),  // GB
            total: parseFloat((totalMem / 1024 / 1024 / 1024).toFixed(1)) // GB
        },
        timestamp: new Date().toISOString()
    });
});

/**
 * 恢复暂停的任务（用户完成验证码后调用，仅 VNC 模式）
 */
app.post('/api/task/:taskId/resume', async (req, res) => {
    const { taskId } = req.params;

    console.log('[API] 收到恢复任务请求:', taskId);

    const paused = pausedTasks.get(taskId);

    if (!paused) {
        return res.status(404).json({
            success: false,
            error: '任务不存在或未暂停'
        });
    }

    try {
        // 检查验证码是否已消失
        const { detectSliderCaptcha } = require('./puppeteer-executor');
        const captchaStillExists = await detectSliderCaptcha(paused.page);

        if (captchaStillExists) {
            return res.json({
                success: false,
                message: '验证码仍然存在，请先完成验证后再点击继续'
            });
        }

        console.log('[API] 验证码已处理，恢复任务执行:', taskId);
        console.log('[API] VNC 保持运行，浏览器继续执行...');

        // 更新进度状态
        taskProgress.set(taskId, {
            taskId,
            status: 'running',
            message: '验证码已处理，继续执行...'
        });

        // 触发恢复回调
        paused.resolve({ resumed: true });
        pausedTasks.delete(taskId);

        res.json({
            success: true,
            message: '任务已恢复执行'
        });

    } catch (err) {
        console.error('[API] 恢复任务失败:', err);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

/**
 * 健康检查
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[TASK-SERVER] HTTP API 服务器运行在 http://0.0.0.0:${PORT}`);
    console.log('[TASK-SERVER] v3.0.0 - 双模式支持（同步 + 异步 VNC）');
    console.log('[TASK-SERVER] 可用端点:');
    console.log('  GET  /api/workflows            - 获取工作流列表');
    console.log('  POST /api/task/execute         - 执行单个任务（双模式）');
    console.log('  GET  /api/task/stream/:taskId  - SSE 实时进度（VNC 模式）');
    console.log('  POST /api/task/:taskId/resume  - 恢复暂停任务（VNC 模式）');
    console.log('  POST /api/task/batch           - 批量执行任务');
    console.log('  GET  /api/cookie-status        - 检查 Cookie 状态');
    console.log('  GET  /api/status               - 服务器状态');
    console.log('  GET  /health                   - 健康检查');
});
