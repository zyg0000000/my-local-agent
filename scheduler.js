/**
 * @file scheduler.js
 * @version 1.0.0
 * @description 全局定时调度器 - 根据 scheduler_config 配置自动执行日报数据抓取
 *
 * 运行方式: pm2 start scheduler.js --name scheduler
 *
 * 核心逻辑:
 * 1. 每小时整点检查 scheduler_config 配置
 * 2. 判断是否需要执行（enabled、时间匹配、频率匹配、今天未执行）
 * 3. 获取选中的项目，二次过滤 active 状态
 * 4. 串行执行每个项目的抓取任务
 * 5. 记录执行日志到 scheduled_executions 集合
 */

require('dotenv').config();
const cron = require('node-cron');
const { MongoClient, ObjectId } = require('mongodb');
const axios = require('axios');

// --- 配置 ---
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = 'agentworks_db';
const TASK_SERVER_URL = process.env.TASK_SERVER_URL || 'http://localhost:3001';

// --- 集合名称 ---
const SCHEDULER_CONFIG_COLLECTION = 'scheduler_config';
const SCHEDULED_EXECUTIONS_COLLECTION = 'scheduled_executions';
const PROJECTS_COLLECTION = 'projects';
const WORKFLOWS_COLLECTION = 'automation-workflows';

// --- 数据库客户端 ---
let client;
let db;

/**
 * 初始化数据库连接
 */
async function initDB() {
    if (db) return db;
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('[SCHEDULER] 成功连接到 MongoDB');
    return db;
}

/**
 * 获取调度配置
 */
async function getSchedulerConfig() {
    const config = await db.collection(SCHEDULER_CONFIG_COLLECTION).findOne({ _id: 'global' });
    return config || {
        _id: 'global',
        enabled: false,
        time: '10:00',
        frequency: 'daily',
        selectedProjectIds: [],
        lastExecutedAt: null
    };
}

/**
 * 判断今天是否为工作日
 */
function isWeekday() {
    const day = new Date().getDay();
    return day !== 0 && day !== 6; // 0=周日, 6=周六
}

/**
 * 判断今天是否已执行过
 */
function hasExecutedToday(lastExecutedAt) {
    if (!lastExecutedAt) return false;
    const lastDate = new Date(lastExecutedAt).toDateString();
    const today = new Date().toDateString();
    return lastDate === today;
}

/**
 * 根据发布日期计算距今天数
 */
function getDaysSincePublish(publishDate) {
    if (!publishDate) return Infinity;
    const publish = new Date(publishDate);
    const today = new Date();
    const diffTime = today.getTime() - publish.getTime();
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * 获取所有抓取工作流
 * 工作流匹配规则（与前端 useDataFetch 一致）:
 * - 14 天内: 名称包含「当日播放量」但不包含「14天后」，使用 taskId
 * - 14 天后: 名称包含「14天后」，使用 videoId
 */
async function getWorkflowRules() {
    const workflows = await db.collection(WORKFLOWS_COLLECTION).find({
        isActive: { $ne: false }
    }).toArray();

    const rules = [];

    // 14 天内工作流（包含"当日播放量"但不包含"14天后"）
    const within14DaysWf = workflows.find(wf =>
        wf.name.includes('当日播放量') && !wf.name.includes('14天后')
    );
    if (within14DaysWf) {
        rules.push({
            name: '14天内抓取',
            daysRange: [0, 14],
            workflowId: within14DaysWf._id.toString(),
            workflowName: within14DaysWf.name,
            requiredInput: 'taskId' // 需要星图任务ID
        });
    }

    // 14 天后工作流（必须包含"14天后"）
    const after14DaysWf = workflows.find(wf =>
        wf.name.includes('14天后')
    );
    if (after14DaysWf) {
        rules.push({
            name: '14天后抓取',
            daysRange: [14, null],
            workflowId: after14DaysWf._id.toString(),
            workflowName: after14DaysWf.name,
            requiredInput: 'videoId' // 需要视频ID
        });
    }

    return rules;
}

/**
 * 根据发布日期选择工作流
 */
function getWorkflowForVideo(workflowRules, publishDate) {
    const days = getDaysSincePublish(publishDate);

    for (const rule of workflowRules) {
        const [min, max] = rule.daysRange;
        if (days >= min && (max === null || days < max)) {
            return rule;
        }
    }
    return null;
}

/**
 * 获取项目中需要抓取的合作记录
 * 只抓取已定档/已发布状态且今天没有数据的记录
 */
async function getCollaborationsToFetch(project) {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const collaborations = project.collaborations || [];

    // 筛选条件:
    // 1. 状态为已定档或已发布
    // 2. 今天没有 dailyStats 数据
    const validStatuses = ['已定档', '已发布'];

    return collaborations.filter(collab => {
        if (!validStatuses.includes(collab.status)) {
            return false;
        }

        // 检查今天是否已有数据
        const hasDataToday = (collab.dailyStats || []).some(stat => stat.date === today);
        return !hasDataToday;
    });
}

/**
 * 执行单个项目的抓取任务
 * @param {Object} project - 项目对象
 * @param {Array} workflowRules - 工作流规则列表
 */
async function executeProjectFetch(project, workflowRules) {
    const projectId = project.id;
    const projectName = project.name;
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    console.log(`[SCHEDULER] 开始执行项目: ${projectName} (${projectId})`);

    // 获取需要抓取的合作记录
    const collaborations = await getCollaborationsToFetch(project);

    if (collaborations.length === 0) {
        console.log(`[SCHEDULER] 项目 ${projectName} 无需抓取的合作记录，跳过`);
        return null;
    }

    console.log(`[SCHEDULER] 项目 ${projectName} 有 ${collaborations.length} 条合作记录需要抓取`);

    // 创建执行记录
    const execution = {
        projectId,
        projectName,
        triggerType: 'scheduled',
        scheduledAt: now,
        executedAt: now,
        completedAt: null,
        status: 'running',
        taskCount: collaborations.length,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
        duration: null,
        error: null,
        tasks: collaborations.map(c => ({
            collaborationId: c.id,
            talentName: c.talentName || '',
            videoId: c.videoUrl?.match(/video\/(\d+)/)?.[1] || null,
            status: 'pending',
            fetchedViews: null,
            error: null,
            duration: null
        })),
        createdAt: now,
        updatedAt: now
    };

    const insertResult = await db.collection(SCHEDULED_EXECUTIONS_COLLECTION).insertOne(execution);
    const executionId = insertResult.insertedId;

    // 串行执行每个抓取任务
    const startTime = Date.now();
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    const updatedTasks = [];

    for (let i = 0; i < collaborations.length; i++) {
        const collab = collaborations[i];
        const taskStartTime = Date.now();

        // 根据发布日期选择工作流
        const publishDate = collab.actualReleaseDate || collab.plannedReleaseDate;
        const workflowRule = getWorkflowForVideo(workflowRules, publishDate);

        if (!workflowRule) {
            console.log(`[SCHEDULER] 合作 ${collab.id} 无匹配工作流，跳过`);
            skippedCount++;
            updatedTasks.push({
                collaborationId: collab.id,
                talentName: collab.talentName || '',
                videoId: null,
                status: 'skipped',
                error: '无匹配工作流',
                duration: Date.now() - taskStartTime
            });
            continue;
        }

        // 根据工作流需要的输入类型获取对应值
        let inputValue = null;
        if (workflowRule.requiredInput === 'taskId') {
            // 14天内：需要星图任务ID
            inputValue = collab.xingtuTaskId || null;
        } else {
            // 14天后：需要视频ID（从 videoUrl 中提取）
            inputValue = collab.videoUrl?.match(/video\/(\d+)/)?.[1] || null;
        }

        if (!inputValue) {
            const missingField = workflowRule.requiredInput === 'taskId' ? '星图任务ID' : '视频ID';
            console.log(`[SCHEDULER] 合作 ${collab.id} 无${missingField}，跳过`);
            skippedCount++;
            updatedTasks.push({
                collaborationId: collab.id,
                talentName: collab.talentName || '',
                videoId: null,
                status: 'skipped',
                error: `无${missingField}`,
                duration: Date.now() - taskStartTime
            });
            continue;
        }

        try {
            const days = getDaysSincePublish(publishDate);
            console.log(`[SCHEDULER] [${i + 1}/${collaborations.length}] ${collab.talentName || collab.id} - 发布${days}天 - 使用${workflowRule.name} - 输入: ${inputValue}`);

            // 调用 task-server 执行抓取
            const response = await axios.post(`${TASK_SERVER_URL}/api/task/execute`, {
                workflowId: workflowRule.workflowId,
                inputValue: inputValue,
                metadata: {
                    projectId,
                    collaborationId: collab.id,
                    reportDate: today,
                    source: 'scheduler'
                }
            }, {
                timeout: 120000 // 120秒超时
            });

            if (response.data.success) {
                const views = response.data.results?.result?.data?.['播放量'];
                successCount++;
                updatedTasks.push({
                    collaborationId: collab.id,
                    talentName: collab.talentName || '',
                    videoId: inputValue,
                    workflowUsed: workflowRule.name,
                    status: 'success',
                    fetchedViews: views ? parseInt(String(views).replace(/,/g, ''), 10) : null,
                    error: null,
                    duration: Date.now() - taskStartTime
                });
                console.log(`[SCHEDULER] ✓ 成功: ${collab.talentName || collab.id} - 播放量: ${views || '未获取'}`);
            } else {
                throw new Error(response.data.error || '抓取失败');
            }

        } catch (error) {
            console.error(`[SCHEDULER] ✗ 失败: ${collab.talentName || collab.id} - ${error.message}`);
            failedCount++;
            updatedTasks.push({
                collaborationId: collab.id,
                talentName: collab.talentName || '',
                videoId: inputValue,
                workflowUsed: workflowRule.name,
                status: 'failed',
                error: error.message,
                duration: Date.now() - taskStartTime
            });
        }

        // 任务间隔，避免请求过快
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const totalDuration = Date.now() - startTime;
    const completedAt = new Date();
    const finalStatus = failedCount === 0 ? 'completed' :
                       (successCount === 0 ? 'failed' : 'completed');

    // 更新执行记录
    await db.collection(SCHEDULED_EXECUTIONS_COLLECTION).updateOne(
        { _id: executionId },
        {
            $set: {
                completedAt,
                status: finalStatus,
                successCount,
                failedCount,
                skippedCount,
                duration: totalDuration,
                tasks: updatedTasks,
                updatedAt: completedAt
            }
        }
    );

    console.log(`[SCHEDULER] 项目 ${projectName} 执行完成: 成功=${successCount}, 失败=${failedCount}, 跳过=${skippedCount}, 耗时=${totalDuration}ms`);

    return {
        projectId,
        projectName,
        executionId: executionId.toString(),
        successCount,
        failedCount,
        skippedCount,
        duration: totalDuration
    };
}

/**
 * 主调度检查函数
 */
async function checkAndExecute() {
    try {
        await initDB();

        const config = await getSchedulerConfig();

        // 检查是否启用
        if (!config.enabled) {
            console.log('[SCHEDULER] 调度未启用，跳过');
            return;
        }

        // 检查当前小时是否匹配
        const currentHour = new Date().getHours();
        const configHour = parseInt(config.time.split(':')[0], 10);

        if (currentHour !== configHour) {
            console.log(`[SCHEDULER] 当前小时(${currentHour})不匹配配置时间(${configHour})，跳过`);
            return;
        }

        // 检查频率（工作日模式）
        if (config.frequency === 'weekdays' && !isWeekday()) {
            console.log('[SCHEDULER] 今天是周末，工作日模式跳过');
            return;
        }

        // 检查今天是否已执行
        if (hasExecutedToday(config.lastExecutedAt)) {
            console.log('[SCHEDULER] 今天已执行过，跳过');
            return;
        }

        // 检查是否有选中的项目
        if (!config.selectedProjectIds || config.selectedProjectIds.length === 0) {
            console.log('[SCHEDULER] 无选中项目，跳过');
            return;
        }

        console.log('[SCHEDULER] ===== 开始执行定时抓取 =====');
        console.log(`[SCHEDULER] 配置: 时间=${config.time}, 频率=${config.frequency}, 项目数=${config.selectedProjectIds.length}`);

        // 获取工作流规则（全局加载一次）
        const workflowRules = await getWorkflowRules();
        if (workflowRules.length === 0) {
            console.error('[SCHEDULER] 未找到抓取工作流，请检查工作流配置');
            console.error('[SCHEDULER] 需要工作流名称包含「当日播放量」或「14天后」');
            return;
        }
        console.log(`[SCHEDULER] 已加载 ${workflowRules.length} 个工作流规则:`);
        workflowRules.forEach(rule => {
            console.log(`  - ${rule.name}: ${rule.workflowName} (需要 ${rule.requiredInput})`);
        });

        // 获取选中的项目，二次过滤 active 状态
        const projects = await db.collection(PROJECTS_COLLECTION).find({
            id: { $in: config.selectedProjectIds },
            'trackingConfig.status': 'active'
        }).toArray();

        if (projects.length === 0) {
            console.log('[SCHEDULER] 所有选中项目都不是 active 状态，跳过');
            return;
        }

        console.log(`[SCHEDULER] 实际执行 ${projects.length} 个项目`);

        // 串行执行每个项目
        const results = [];
        for (const project of projects) {
            try {
                const result = await executeProjectFetch(project, workflowRules);
                if (result) {
                    results.push(result);
                }
            } catch (error) {
                console.error(`[SCHEDULER] 项目 ${project.name} 执行失败:`, error.message);
            }

            // 项目间隔
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        // 更新 lastExecutedAt
        await db.collection(SCHEDULER_CONFIG_COLLECTION).updateOne(
            { _id: 'global' },
            { $set: { lastExecutedAt: new Date() } }
        );

        console.log('[SCHEDULER] ===== 定时抓取执行完成 =====');
        console.log(`[SCHEDULER] 结果: ${results.length} 个项目执行完成`);
        results.forEach(r => {
            console.log(`  - ${r.projectName}: 成功=${r.successCount}, 失败=${r.failedCount}`);
        });

    } catch (error) {
        console.error('[SCHEDULER] 调度执行错误:', error);
    }
}

/**
 * 启动调度器
 */
async function start() {
    console.log('[SCHEDULER] 启动全局定时调度器...');
    console.log(`[SCHEDULER] MongoDB: ${MONGO_URI ? '已配置' : '未配置'}`);
    console.log(`[SCHEDULER] Task Server: ${TASK_SERVER_URL}`);

    // 初始化数据库连接
    await initDB();

    // 注册 cron 任务：每小时整点执行
    // 格式: 秒 分 时 日 月 周
    cron.schedule('0 0 * * * *', () => {
        console.log(`[SCHEDULER] 整点检查: ${new Date().toISOString()}`);
        checkAndExecute();
    });

    console.log('[SCHEDULER] Cron 任务已注册: 每小时整点检查');
    console.log('[SCHEDULER] 调度器启动完成，等待执行...');

    // 启动时立即检查一次（用于测试）
    if (process.env.SCHEDULER_CHECK_ON_START === 'true') {
        console.log('[SCHEDULER] 启动时立即执行一次检查');
        await checkAndExecute();
    }
}

// 启动
start().catch(err => {
    console.error('[SCHEDULER] 启动失败:', err);
    process.exit(1);
});
