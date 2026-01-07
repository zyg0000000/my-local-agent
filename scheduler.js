/**
 * @file scheduler.js
 * @version 1.4.1
 * @description 全局定时调度器 - 根据 system_config 配置自动执行日报数据抓取
 *
 * v1.4.1 变更 (2026-01-07):
 * - 修复星图任务ID字段名：xingtuTaskId → taskId（与云函数保持一致）
 * - 兼容两种字段名：collab.taskId || collab.xingtuTaskId
 *
 * v1.4.0 变更 (2026-01-07):
 * - 支持 15 分钟间隔时间调度（不再仅限整点）
 * - 新增 getCurrentTimeSlot() 函数获取当前 15 分钟时间槽
 * - getProjectScheduleHour → getProjectScheduleTime 改为返回完整 HH:MM
 * - 时间匹配从小时级改为 15 分钟级
 *
 * v1.3.3 变更 (2026-01-07):
 * - 修复数据保存：抓取成功后将播放量保存到 collaboration 的 dailyStats
 * - 正确处理带"w"或"万"后缀的播放量数值（如 1,545.92w = 15459200）
 *
 * v1.3.2 变更 (2026-01-07):
 * - 修复数据源：从独立的 collaborations 集合查询合作记录
 * - AgentWorks 的合作记录不是嵌入在 project 中，而是独立集合
 *
 * v1.3.1 变更 (2026-01-07):
 * - 修复合作记录状态筛选逻辑，支持更多状态值
 * - 新增：只要有视频URL和发布日期就认为可抓取
 * - 添加调试日志输出合作记录状态详情
 *
 * v1.3.0 变更 (2026-01-07):
 * - 新增按项目时间调度功能
 * - 每个项目可设置独立的执行时间 (time 字段)
 * - 未设置时间的项目使用全局默认时间
 * - 移除全局 lastExecutedAt 检查，改为按项目检查执行记录
 *
 * v1.2.0 变更 (2026-01-07):
 * - 新增 scheduledProjects 支持，兼容常规日报和联投日报
 * - 常规日报 (type='standard'): 使用自动工作流选择逻辑
 * - 联投日报 (type='joint'): 使用指定的 workflowId 和 accountId
 * - 向后兼容 selectedProjectIds 字段
 *
 * v1.1.0 变更 (2026-01-06):
 * - 修复集合名称: scheduler_config → system_config
 * - 修复查询条件: { _id: 'global' } → { configType: 'daily_report_scheduler' }
 * - 与云函数 dailyReportApi 保持一致，解决配置保存不生效的问题
 *
 * 运行方式: pm2 start scheduler.js --name scheduler
 *
 * 核心逻辑:
 * 1. 每小时整点检查 scheduler_config 配置
 * 2. 筛选当前小时应执行的项目（根据项目独立时间或全局默认时间）
 * 3. 检查项目今天是否已执行过（查询执行记录）
 * 4. 获取选中的项目，二次过滤 active 状态
 * 5. 根据项目类型执行不同的抓取逻辑
 * 6. 记录执行日志到 scheduled_executions 集合
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
// v1.1: 修复集合名称，与云函数 dailyReportApi 保持一致
const SCHEDULER_CONFIG_COLLECTION = 'system_config';
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
 * v1.2: 新增 scheduledProjects 支持
 * v1.1: 修改查询条件，与云函数 dailyReportApi 保持一致
 */
async function getSchedulerConfig() {
    const config = await db.collection(SCHEDULER_CONFIG_COLLECTION).findOne({
        configType: 'daily_report_scheduler'
    });
    return config || {
        configType: 'daily_report_scheduler',
        enabled: false,
        time: '10:00',
        frequency: 'daily',
        selectedProjectIds: [],
        scheduledProjects: [],  // v1.2: 新增
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
 * 判断今天是否已执行过（全局）
 * @deprecated v1.3.0 改用 hasProjectExecutedToday
 */
function hasExecutedToday(lastExecutedAt) {
    if (!lastExecutedAt) return false;
    const lastDate = new Date(lastExecutedAt).toDateString();
    const today = new Date().toDateString();
    return lastDate === today;
}

/**
 * v1.3.0: 检查项目今天是否已执行过
 * 查询 scheduled_executions 集合中今天的执行记录
 */
async function hasProjectExecutedToday(projectId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const execution = await db.collection(SCHEDULED_EXECUTIONS_COLLECTION).findOne({
        projectId: projectId,
        triggerType: 'scheduled',
        executedAt: { $gte: today },
        status: { $in: ['running', 'completed'] }
    });

    return !!execution;
}

/**
 * v1.4.0: 获取项目的执行时间（完整 HH:MM 格式）
 * 如果项目有独立时间则使用，否则使用全局默认时间
 */
function getProjectScheduleTime(projectConfig, globalDefaultTime) {
    return projectConfig.time || globalDefaultTime || '10:00';
}

/**
 * v1.4.0: 获取当前时间的 HH:MM 格式（15 分钟对齐）
 * 例如：10:07 → 10:00，10:17 → 10:15，10:32 → 10:30，10:47 → 10:45
 */
function getCurrentTimeSlot() {
    const now = new Date();
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = Math.floor(now.getMinutes() / 15) * 15;
    const minuteStr = String(minute).padStart(2, '0');
    return `${hour}:${minuteStr}`;
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
 * 只抓取已发布视频状态且今天没有数据的记录
 *
 * v1.3.1: 扩展状态检查，支持更多状态值
 * v1.3.2: 修复数据源，从独立的 collaborations 集合查询
 */
async function getCollaborationsToFetch(project) {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // v1.3.2: AgentWorks 的合作记录存储在独立集合中
    // 优先从 collaborations 集合查询，兼容嵌入式结构
    let collaborations = project.collaborations || [];

    if (collaborations.length === 0 && project.id) {
        // 从独立集合查询
        collaborations = await db.collection('collaborations')
            .find({ projectId: project.id })
            .toArray();
        console.log(`[SCHEDULER] 从 collaborations 集合查询到 ${collaborations.length} 条记录`);
    }

    // 筛选条件:
    // 1. 状态包含"已定档"、"已发布"、"视频已发布"等
    // 2. 或者有 videoUrl/videoId 表示视频已发布
    // 3. 今天没有 dailyStats 数据
    const validStatuses = ['已定档', '已发布', '视频已发布', '已发布视频', 'published', 'video_published'];

    // 调试：输出所有合作记录的状态
    // v1.3.2: 支持 AgentWorks 的字段命名 (actualReleaseDate, plannedReleaseDate)
    if (collaborations.length > 0) {
        const statusSummary = collaborations.map(c => ({
            name: c.talentName,
            status: c.status,
            hasVideo: !!(c.videoUrl || c.videoId || c.video?.videoId),
            publishDate: c.actualReleaseDate || c.plannedReleaseDate || c.publishDate || c.video?.publishDate,
            lastDataDate: c.dailyStats?.length > 0 ? c.dailyStats[c.dailyStats.length - 1]?.date : null
        }));
        console.log(`[SCHEDULER] 项目 ${project.name} 合作记录状态: ${JSON.stringify(statusSummary)}`);
    }

    return collaborations.filter(collab => {
        // 检查状态（不区分大小写，支持部分匹配）
        const status = (collab.status || '').toLowerCase();
        const hasValidStatus = validStatuses.some(vs =>
            status.includes(vs.toLowerCase()) || vs.toLowerCase().includes(status)
        );

        // 如果状态不匹配，检查是否有视频（有视频说明已发布）
        const hasVideo = !!(collab.videoUrl || collab.videoId || collab.video?.videoId);
        // v1.3.2: 支持 AgentWorks 的发布日期字段
        const hasPublishDate = !!(collab.actualReleaseDate || collab.plannedReleaseDate || collab.publishDate || collab.video?.publishDate);

        // 只要有视频且有发布日期，就认为可以抓取
        if (!hasValidStatus && !(hasVideo && hasPublishDate)) {
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
            videoId: c.videoId || c.videoUrl?.match(/video\/(\d+)/)?.[1] || null,
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
            // 14天内：需要星图任务ID（字段名为 taskId，与云函数保持一致）
            inputValue = collab.taskId || collab.xingtuTaskId || null;
        } else {
            // 14天后：需要视频ID（从 videoUrl 中提取）
            inputValue = collab.videoId || collab.videoUrl?.match(/video\/(\d+)/)?.[1] || null;
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
                const viewsNumeric = views ? parseInt(String(views).replace(/[,w万]/gi, ''), 10) : null;
                // 处理带"w"或"万"的数值（如 1,545.92w = 15459200）
                const finalViews = views && (views.toString().includes('w') || views.toString().includes('万'))
                    ? Math.round(parseFloat(views.toString().replace(/[,w万]/gi, '')) * 10000)
                    : viewsNumeric;

                // v1.3.3: 保存数据到 collaboration 的 dailyStats
                if (finalViews) {
                    await db.collection('collaborations').updateOne(
                        { id: collab.id },
                        {
                            $push: {
                                dailyStats: {
                                    date: today,
                                    data: { '播放量': finalViews },
                                    solution: '',
                                    source: 'scheduler',
                                    createdAt: new Date(),
                                    updatedAt: new Date()
                                }
                            },
                            $set: {
                                lastReportDate: today,
                                updatedAt: new Date()
                            }
                        }
                    );
                    console.log(`[SCHEDULER] 数据已保存: ${collab.talentName || collab.id} - ${today} - 播放量: ${finalViews}`);
                }

                successCount++;
                updatedTasks.push({
                    collaborationId: collab.id,
                    talentName: collab.talentName || '',
                    videoId: inputValue,
                    workflowUsed: workflowRule.name,
                    status: 'success',
                    fetchedViews: finalViews,
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
 * v1.2: 执行联投项目的抓取任务
 * 联投日报使用指定的工作流和账户，通过 fetchableDate 确定可抓取日期
 *
 * @param {Object} project - 项目对象
 * @param {Object} projectConfig - 项目配置 { projectId, type, workflowId, accountId }
 */
async function executeJointProjectFetch(project, projectConfig) {
    const projectId = project.id;
    const projectName = project.name;
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    console.log(`[SCHEDULER] 开始执行联投项目: ${projectName} (${projectId})`);
    console.log(`[SCHEDULER] 联投配置: workflowId=${projectConfig.workflowId || '自动'}, accountId=${projectConfig.accountId || '默认'}`);

    // 获取需要抓取的合作记录
    // 联投日报的特点：需要检查 fetchableDate（T+1 规则）
    const collaborations = await getJointCollaborationsToFetch(project, today);

    if (collaborations.length === 0) {
        console.log(`[SCHEDULER] 联投项目 ${projectName} 无需抓取的合作记录，跳过`);
        return null;
    }

    console.log(`[SCHEDULER] 联投项目 ${projectName} 有 ${collaborations.length} 条合作记录需要抓取`);

    // 确定使用的工作流
    let workflowId = projectConfig.workflowId;
    let workflowName = '指定工作流';

    if (!workflowId) {
        // 如果没有指定工作流，尝试自动选择联投专用工作流
        const jointWorkflow = await db.collection(WORKFLOWS_COLLECTION).findOne({
            name: { $regex: /联投.*播放量/i },
            isActive: { $ne: false }
        });
        if (jointWorkflow) {
            workflowId = jointWorkflow._id.toString();
            workflowName = jointWorkflow.name;
        } else {
            console.error(`[SCHEDULER] 联投项目 ${projectName} 未找到联投工作流，跳过`);
            return null;
        }
    }

    console.log(`[SCHEDULER] 使用工作流: ${workflowName} (${workflowId})`);

    // 创建执行记录
    const execution = {
        projectId,
        projectName,
        projectType: 'joint',  // v1.2: 标记项目类型
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
            videoId: c.videoId || c.videoUrl?.match(/video\/(\d+)/)?.[1] || null,
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

        // 联投日报使用 videoId
        // v1.3.2: 优先使用直接的 videoId 字段
        const videoId = collab.videoId || collab.videoUrl?.match(/video\/(\d+)/)?.[1] || null;

        if (!videoId) {
            console.log(`[SCHEDULER] 联投合作 ${collab.id} 无视频ID，跳过`);
            skippedCount++;
            updatedTasks.push({
                collaborationId: collab.id,
                talentName: collab.talentName || '',
                videoId: null,
                status: 'skipped',
                error: '无视频ID',
                duration: Date.now() - taskStartTime
            });
            continue;
        }

        try {
            console.log(`[SCHEDULER] [${i + 1}/${collaborations.length}] ${collab.talentName || collab.id} - 联投抓取 - videoId: ${videoId}`);

            // 调用 task-server 执行抓取
            const response = await axios.post(`${TASK_SERVER_URL}/api/task/execute`, {
                workflowId: workflowId,
                inputValue: videoId,
                accountId: projectConfig.accountId || undefined,  // 使用指定账户
                metadata: {
                    projectId,
                    collaborationId: collab.id,
                    reportDate: today,
                    source: 'scheduler',
                    projectType: 'joint'
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
                    videoId: videoId,
                    workflowUsed: workflowName,
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
                videoId: videoId,
                workflowUsed: workflowName,
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

    console.log(`[SCHEDULER] 联投项目 ${projectName} 执行完成: 成功=${successCount}, 失败=${failedCount}, 跳过=${skippedCount}, 耗时=${totalDuration}ms`);

    return {
        projectId,
        projectName,
        projectType: 'joint',
        executionId: executionId.toString(),
        successCount,
        failedCount,
        skippedCount,
        duration: totalDuration
    };
}

/**
 * v1.2: 获取联投项目中需要抓取的合作记录
 * 联投日报使用 fetchableDate 规则（T+1）
 */
async function getJointCollaborationsToFetch(project, today) {
    const collaborations = project.collaborations || [];

    // 筛选条件:
    // 1. 状态为已定档或已发布
    // 2. 今天没有 dailyStats 数据
    // 3. fetchableDate <= today（T+1 规则）
    const validStatuses = ['已定档', '已发布', 'scheduled', 'published'];

    return collaborations.filter(collab => {
        if (!validStatuses.includes(collab.status)) {
            return false;
        }

        // 检查 fetchableDate（T+1 规则）
        const publishDate = collab.actualReleaseDate || collab.plannedReleaseDate;
        if (publishDate) {
            // 发布日期的第二天才能抓取
            const fetchableDate = new Date(publishDate);
            fetchableDate.setDate(fetchableDate.getDate() + 1);
            const fetchableDateStr = fetchableDate.toISOString().split('T')[0];

            if (fetchableDateStr > today) {
                // 还不能抓取（T+1 规则未满足）
                return false;
            }
        }

        // 检查今天是否已有数据
        const hasDataToday = (collab.dailyStats || []).some(stat => stat.date === today);
        return !hasDataToday;
    });
}

/**
 * 主调度检查函数
 * v1.3.0: 支持按项目时间调度
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

        // v1.4.0: 使用 15 分钟时间槽而非仅小时
        const currentTimeSlot = getCurrentTimeSlot();
        const globalDefaultTime = config.time || '10:00';

        // 检查频率（工作日模式）
        if (config.frequency === 'weekdays' && !isWeekday()) {
            console.log('[SCHEDULER] 今天是周末，工作日模式跳过');
            return;
        }

        // v1.2: 检查是否有项目（优先使用 scheduledProjects，兼容 selectedProjectIds）
        const scheduledProjects = config.scheduledProjects || [];
        const selectedProjectIds = config.selectedProjectIds || [];

        // 构建项目配置列表：合并 scheduledProjects 和 selectedProjectIds
        let allProjectConfigs = [];

        if (scheduledProjects.length > 0) {
            // 使用新的 scheduledProjects 结构
            allProjectConfigs = scheduledProjects.map(sp => ({
                projectId: sp.projectId,
                type: sp.type || 'standard',
                time: sp.time || null,  // v1.3.0: 项目独立时间
                workflowId: sp.workflowId || null,
                accountId: sp.accountId || null
            }));
        } else if (selectedProjectIds.length > 0) {
            // 向后兼容：使用旧的 selectedProjectIds
            allProjectConfigs = selectedProjectIds.map(id => ({
                projectId: id,
                type: 'standard',
                time: null,
                workflowId: null,
                accountId: null
            }));
        }

        if (allProjectConfigs.length === 0) {
            console.log('[SCHEDULER] 无选中项目，跳过');
            return;
        }

        // v1.3.0: 筛选当前小时应执行的项目
        const projectConfigs = allProjectConfigs.filter(pc => {
            const projectTime = getProjectScheduleTime(pc, globalDefaultTime);
            return projectTime === currentTimeSlot;
        });

        if (projectConfigs.length === 0) {
            console.log(`[SCHEDULER] 当前时间槽(${currentTimeSlot})无匹配项目，跳过`);
            // 显示各项目的调度时间供参考
            const scheduleInfo = allProjectConfigs.map(pc => ({
                projectId: pc.projectId,
                time: getProjectScheduleTime(pc, globalDefaultTime)
            }));
            console.log(`[SCHEDULER] 项目调度时间: ${JSON.stringify(scheduleInfo)}`);
            return;
        }

        console.log('[SCHEDULER] ===== 开始执行定时抓取 =====');
        console.log(`[SCHEDULER] 当前时间槽: ${currentTimeSlot}, 全局默认时间: ${globalDefaultTime}`);
        console.log(`[SCHEDULER] 本次执行项目数: ${projectConfigs.length}/${allProjectConfigs.length}`);

        // 统计项目类型
        const standardCount = projectConfigs.filter(p => p.type === 'standard').length;
        const jointCount = projectConfigs.filter(p => p.type === 'joint').length;
        console.log(`[SCHEDULER] 项目类型: 常规日报=${standardCount}, 联投日报=${jointCount}`);

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

        // v1.2: 获取项目，二次过滤 active 状态
        const projectIds = projectConfigs.map(pc => pc.projectId);
        const projects = await db.collection(PROJECTS_COLLECTION).find({
            id: { $in: projectIds },
            'trackingConfig.status': 'active'
        }).toArray();

        if (projects.length === 0) {
            console.log('[SCHEDULER] 所有选中项目都不是 active 状态，跳过');
            return;
        }

        // 创建 projectId -> projectConfig 的映射
        const projectConfigMap = new Map(projectConfigs.map(pc => [pc.projectId, pc]));

        console.log(`[SCHEDULER] 待执行项目数: ${projects.length} 个`);

        // v1.3.0: 串行执行每个项目，带有按项目执行检查
        const results = [];
        let skippedCount = 0;
        for (const project of projects) {
            try {
                // 获取该项目的配置
                const projectConfig = projectConfigMap.get(project.id) || { type: 'standard' };

                // v1.3.0: 检查该项目今天是否已执行
                const alreadyExecuted = await hasProjectExecutedToday(project.id);
                if (alreadyExecuted) {
                    console.log(`[SCHEDULER] 项目 ${project.name} 今天已执行过，跳过`);
                    skippedCount++;
                    continue;
                }

                console.log(`[SCHEDULER] 开始执行项目: ${project.name} (调度时间: ${projectConfig.time || '默认'})`);

                let result;
                if (projectConfig.type === 'joint') {
                    // 联投日报：使用指定的工作流和账户
                    console.log(`[SCHEDULER] 项目 ${project.name} 为联投日报，使用指定工作流`);
                    result = await executeJointProjectFetch(project, projectConfig);
                } else {
                    // 常规日报：使用自动工作流选择
                    result = await executeProjectFetch(project, workflowRules);
                }

                if (result) {
                    results.push(result);
                }
            } catch (error) {
                console.error(`[SCHEDULER] 项目 ${project.name} 执行失败:`, error.message);
            }

            // 项目间隔
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        // v1.3.0: 更新 lastExecutedAt 仍然保留（用于概览显示）
        await db.collection(SCHEDULER_CONFIG_COLLECTION).updateOne(
            { configType: 'daily_report_scheduler' },
            { $set: { lastExecutedAt: new Date() } }
        );

        console.log(`[SCHEDULER] 本次执行: 已跳过=${skippedCount}, 实际执行=${results.length}`);

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

    // 注册 cron 任务：每 15 分钟检查一次（便于测试）
    // 格式: 秒 分 时 日 月 周
    // v1.3.1: 从每小时改为每 15 分钟
    cron.schedule('0 */15 * * * *', () => {
        console.log(`[SCHEDULER] 定时检查: ${new Date().toISOString()}`);
        checkAndExecute();
    });

    console.log('[SCHEDULER] Cron 任务已注册: 每 15 分钟检查');
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
