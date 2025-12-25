/**
 * @file task-server.js
 * @description HTTP API 服务器，提供按需执行工作流的能力
 * 运行方式: pm2 start task-server.js --name task-server
 *
 * 与 local-agent.js 的区别：
 * - local-agent.js: 轮询模式，持续监听 MongoDB 中的任务队列
 * - task-server.js: API 模式，按需触发执行工作流
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const os = require('os');
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');

// 引入 puppeteer-executor 的核心功能
// executeActions 内部处理：浏览器启动、Cookie 加载、步骤执行、浏览器关闭
const { executeActions } = require('./puppeteer-executor');

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
                description: 1
            })
            .toArray();

        // 转换格式
        const result = workflows.map(w => ({
            id: w._id.toString(),
            name: w.name,
            requiredInput: w.requiredInput?.key || 'xingtuId',
            inputLabel: w.requiredInput?.label || '星图 ID',
            description: w.description || ''
        }));

        res.json(result);
    } catch (err) {
        console.error('[API] 获取工作流失败:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 执行工作流
 * executeActions 内部处理浏览器生命周期，无需外部管理
 */
app.post('/api/task/execute', async (req, res) => {
    const { workflowId, inputValue, metadata } = req.body;

    if (!workflowId || !inputValue) {
        return res.status(400).json({
            success: false,
            error: '缺少必要参数: workflowId 和 inputValue'
        });
    }

    console.log(`[API] 收到执行请求: workflow=${workflowId}, input=${inputValue}`);

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

        // 构建任务对象（与 local-agent.js 格式一致）
        // [v3.1] 优先使用 inputConfig（agentworks_db 新格式），兼容 requiredInput（旧格式）
        const inputKey = workflow.inputConfig?.key || workflow.requiredInput?.key || 'xingtuId';
        const task = {
            _id: new ObjectId(),
            [inputKey]: inputValue,
            workflowName: workflow.name,
            metadata: metadata || {},
            createdAt: new Date()
        };

        // 执行工作流
        // executeActions 内部会：启动浏览器 → 加载 Cookie → 执行步骤 → 关闭浏览器
        console.log(`[API] 开始执行工作流: ${workflow.name}`);
        const startTime = Date.now();

        const results = await executeActions(task, workflow);

        const duration = Date.now() - startTime;
        console.log(`[API] 工作流执行完成，耗时 ${duration}ms`);

        res.json({
            success: true,
            workflowId,
            workflowName: workflow.name,
            inputValue,
            taskId: task._id.toString(),
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
 * 健康检查
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[TASK-SERVER] HTTP API 服务器运行在 http://0.0.0.0:${PORT}`);
    console.log('[TASK-SERVER] 可用端点:');
    console.log('  GET  /api/workflows       - 获取工作流列表');
    console.log('  POST /api/task/execute    - 执行单个任务');
    console.log('  POST /api/task/batch      - 批量执行任务');
    console.log('  GET  /api/cookie-status   - 检查 Cookie 状态');
    console.log('  GET  /api/status          - 服务器状态');
    console.log('  GET  /health              - 健康检查');
});
