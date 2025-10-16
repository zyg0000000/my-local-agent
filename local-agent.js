/**
 * @file local-agent.js
 * @version 3.2 - Persistence Fix
 * @description [核心修复] 增加了数据持久化逻辑，解决了日报数据抓取后刷新丢失的问题。
 * - [新增逻辑] 在 `processNextTask` 函数中，当一个任务成功完成后，本代理现在会主动调用 `/daily-stats` API。
 * - [功能] 将抓取到的播放量 (`播放量`) 连同 `projectId` 和 `reportDate` 一起发送，确保数据被永久写入到 `works` 集合的 `dailyStats` 数组中。
 * - [健壮性] 此修改确保了自动化流程的数据闭环，即使前端页面关闭，数据也能被正确保存。
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { executeActions, handleLogin } = require('./puppeteer-executor');
const axios = require('axios'); // 引入 axios 用于 API 请求

// --- 配置 ---
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'kol_data';
const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL_MS, 10) || 5000;
const AGENT_ID = `agent-${uuidv4()}`;
const WATCH_MODE = process.argv.includes('--watch');
// [新增] 后端API网关地址，用于调用 /daily-stats
const API_BASE_URL = 'https://sd2pl0r2pkvfku8btbid0.apigateway-cn-shanghai.volceapi.com';

// --- 数据库客户端 ---
const client = new MongoClient(MONGO_URI);
let db;

/**
 * [新增] 调用后端 API 将抓取结果持久化到 works 集合
 * @param {object} task - 已完成的任务对象
 */
async function persistScrapedData(task) {
    // 检查任务结果是否有效
    const views = task.result?.data?.['播放量'];
    const collaborationId = task.metadata?.collaborationId;
    const projectId = task.projectId;
    const reportDate = task.metadata?.reportDate; // 从 metadata 中获取报告日期

    if (!views || !collaborationId || !projectId || !reportDate) {
        console.warn(`[AGENT-PERSIST] 任务 ${task._id} 缺少必要信息，跳过持久化。`, { views, collaborationId, projectId, reportDate });
        return;
    }

    console.log(`[AGENT-PERSIST] 准备将任务 ${task._id} 的结果持久化到 works 集合...`);

    try {
        const payload = {
            projectId: projectId,
            date: reportDate,
            data: [{
                collaborationId: collaborationId,
                totalViews: parseInt(String(views).replace(/,/g, ''), 10)
            }]
        };

        await axios.post(`${API_BASE_URL}/daily-stats`, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        
        console.log(`[AGENT-PERSIST] 成功将 collaborationId: ${collaborationId} 在 ${reportDate} 的播放量 ${views} 写入数据库。`);

    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error(`[AGENT-PERSIST] CRITICAL: 持久化任务 ${task._id} 的数据失败: ${errorMessage}`);
        // 即使持久化失败，我们也不应该让整个任务失败，只记录错误即可。
    }
}


/**
 * 主处理函数
 */
async function processNextTask() {
    let task = null;
    try {
        const tasksCollection = db.collection('automation-tasks');
        const workflowsCollection = db.collection('automation-workflows');

        const updatedTask = await tasksCollection.findOneAndUpdate(
            { status: 'pending' },
            { $set: { status: 'processing', agentId: AGENT_ID, processingAt: new Date() } },
            { sort: { createdAt: 1 }, returnDocument: 'after' }
        );

        if (!updatedTask) {
            if (WATCH_MODE) {
                const timestamp = new Date().toISOString();
                process.stdout.write(`[${timestamp}] 未发现待处理任务...\r`);
            }
            return false;
        }
        
        task = updatedTask;

        console.log(`\n[AGENT] 成功锁定任务: ${task._id}, 开始处理...`);
        
        const workflow = await workflowsCollection.findOne({ _id: new ObjectId(task.workflowId) });

        if (!workflow) {
            throw new Error(`数据库中无法找到 ID 为 ${task.workflowId} 的工作流。`);
        }
        
        const executionResult = await executeActions(task, workflow);

        await tasksCollection.updateOne(
            { _id: new ObjectId(task._id) },
            { $set: executionResult }
        );

        console.log(`[AGENT] 任务 ${task._id} 处理完成，最终状态为 '${executionResult.status}'。`);
        
        // --- [核心修改] ---
        // 如果任务成功，则触发数据持久化逻辑
        if (executionResult.status === 'completed') {
            const completedTask = { ...task, ...executionResult };
            await persistScrapedData(completedTask);
        }
        // --- [修改结束] ---

        // Job状态同步保持不变
        await recalculateAndSyncJobStats(task.jobId, db);
        
        return true;

    } catch (error) {
        console.error(`[AGENT] 处理任务时发生严重错误: ${error.message}`);
        if (task && task._id) {
            console.log(`[AGENT] 正在将任务 ${task._id} 的状态更新为 'failed'`);
            const tasksCollection = db.collection('automation-tasks');
            await tasksCollection.updateOne(
                { _id: new ObjectId(task._id) },
                {
                    $set: {
                        status: 'failed',
                        updatedAt: new Date(),
                        errorMessage: error.stack,
                    }
                }
            );
            await recalculateAndSyncJobStats(task.jobId, db);
        }
        return false;
    }
}

/**
 * [新增] 重新计算并同步父Job状态和统计数据的本地函数
 * @param {ObjectId} jobId - 需要同步的 Job 的 ObjectId
 * @param {Db} db - MongoDB 数据库连接实例
 */
async function recalculateAndSyncJobStats(jobId, db) {
    if (!jobId || !ObjectId.isValid(jobId)) {
        console.log(`[Job Sync] Task has no associated job. Skipping sync.`);
        return;
    }

    console.log(`[Job Sync] Recalculating stats for job ${jobId}...`);
    const tasksCollection = db.collection('automation-tasks');
    const jobsCollection = db.collection('automation-jobs');

    try {
        const statsPipeline = [
            { $match: { jobId: new ObjectId(jobId) } },
            {
                $group: {
                    _id: "$jobId",
                    totalTasks: { $sum: 1 },
                    successTasks: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
                    failedTasks: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
                    pendingTasks: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
                    processingTasks: { $sum: { $cond: [{ $eq: ["$status", "processing"] }, 1, 0] } },
                }
            }
        ];
        
        const results = await tasksCollection.aggregate(statsPipeline).toArray();
        const stats = results[0] || { totalTasks: 0, successTasks: 0, failedTasks: 0, pendingTasks: 0, processingTasks: 0 };
        
        let newStatus = 'processing';
        if (stats.pendingTasks === 0 && stats.processingTasks === 0) {
            newStatus = 'awaiting_review';
        }
        if (stats.totalTasks === 0) {
             newStatus = 'awaiting_review';
        }

        const updatePayload = {
            status: newStatus,
            totalTasks: stats.totalTasks,
            successTasks: stats.successTasks,
            failedTasks: stats.failedTasks,
            updatedAt: new Date(),
        };

        await jobsCollection.updateOne(
            { _id: new ObjectId(jobId) },
            { $set: updatePayload }
        );

        console.log(`[Job Sync] Successfully synced job ${jobId}.`);

    } catch (error) {
        console.error(`[Job Sync] CRITICAL: Failed to sync stats for job ${jobId}:`, error);
    }
}


/**
 * 主循环函数
 */
async function mainLoop() {
    await processNextTask();
    setTimeout(mainLoop, POLLING_INTERVAL);
}

/**
 * 程序入口
 */
async function start() {
    console.log(`[AGENT] 启动本地自动化代理... ID: ${AGENT_ID}`);
    console.log(`[AGENT] 运行模式: ${WATCH_MODE ? '常驻监听' : '按需执行'}`);
    try {
        await client.connect();
        db = client.db(DB_NAME);
        console.log('[DB] 成功连接到 MongoDB。');

        console.log('\n--- 登录流程 ---');
        await handleLogin();
        
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log(`\n[AGENT] 请在弹出的浏览器窗口中手动完成扫码登录。`);
        console.log(`[AGENT] 登录成功并跳转到星图后台，请确认浏览器状态。`);
        console.log(`[AGENT] 按 Enter 键开始处理任务...`);
        await new Promise(resolve => rl.question('', resolve));
        rl.close();
        
        console.log('\n--- 任务处理 ---');
        mainLoop();

    } catch (err) {
        console.error('启动时发生错误:', err);
        process.exit(1);
    }
}

start();
