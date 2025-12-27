/**
 * refresh-userdata.js
 * 本地登录脚本：使用 userDataDir 登录星图，然后同步到 ECS
 *
 * 使用方法：node refresh-userdata.js
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 配置
const CONFIG = {
    // 本地 userDataDir（将用于登录）
    localUserDataDir: path.join(__dirname, 'user_data_agent'),
    // 星图登录页
    loginUrl: 'https://www.xingtu.cn/login',
    // 登录成功后会跳转到的页面
    successUrlPattern: /xingtu\.cn\/(gw|ad|supplier)/,
    // ECS 服务器配置
    ecsHost: '14.103.18.8',
    ecsUser: 'root',
    ecsPassword: '64223902Kz',
    ecsUserDataDir: '/opt/puppeteer-executor/user_data_agent',
    // 超时时间（5分钟）
    timeout: 5 * 60 * 1000
};

/**
 * 等待用户按 Enter 键
 */
function waitForEnter(message) {
    return new Promise(resolve => {
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(message || '按 Enter 键继续...', () => {
            rl.close();
            resolve();
        });
    });
}

/**
 * 主流程
 */
async function main() {
    console.log('='.repeat(60));
    console.log('🚀 星图 UserDataDir 同步工具');
    console.log('='.repeat(60));
    console.log('');
    console.log('📋 使用说明：');
    console.log('   1. 浏览器会打开星图登录页（使用本地 userDataDir）');
    console.log('   2. 请手动登录星图（完成滑块验证）');
    console.log('   3. 登录成功后，随意浏览确认状态正常');
    console.log('   4. 确认后脚本会将 userDataDir 同步到 ECS');
    console.log('');
    console.log(`📁 本地 userDataDir: ${CONFIG.localUserDataDir}`);
    console.log(`🖥️  ECS 地址: ${CONFIG.ecsHost}`);
    console.log('');

    await waitForEnter('准备好后按 Enter 键启动浏览器...');

    console.log('⏳ 正在启动浏览器...');

    const browser = await puppeteer.launch({
        headless: false,  // 显示浏览器窗口
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        userDataDir: CONFIG.localUserDataDir,
        defaultViewport: null,
        args: [
            '--start-maximized',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    try {
        const page = await browser.newPage();

        // 导航到登录页
        console.log('📍 正在打开星图登录页...');
        await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        const currentUrl = page.url();

        // 检查是否已经登录
        if (CONFIG.successUrlPattern.test(currentUrl)) {
            console.log('✅ 检测到已登录状态！');
            console.log('');
            console.log('👉 请在浏览器中确认登录状态正常（可以访问达人主页等）');
        } else {
            console.log('');
            console.log('👆 请在浏览器中完成登录操作');
            console.log('   （等待登录成功，最长等待 5 分钟）');
            console.log('');

            // 等待登录成功
            await page.waitForFunction(
                (pattern) => new RegExp(pattern).test(window.location.href),
                { timeout: CONFIG.timeout },
                CONFIG.successUrlPattern.source
            );

            console.log('✅ 检测到登录成功！');
        }

        console.log('');
        console.log('🔍 验证登录状态...');

        // 访问一个达人主页验证
        const testUrl = 'https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/7211005162712727610';
        await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        await new Promise(r => setTimeout(r, 2000));

        const finalUrl = page.url();
        const isRedirected = finalUrl.includes('redirect_uri');

        if (isRedirected) {
            console.log('⚠️  警告：页面被重定向，登录状态可能有问题');
            console.log(`   当前 URL: ${finalUrl}`);
            console.log('');
            console.log('请检查浏览器，确认是否需要重新登录');
            await waitForEnter('确认登录正常后按 Enter 继续...');
        } else {
            console.log('✅ 登录状态验证通过！');
            const title = await page.title();
            console.log(`   页面标题: ${title}`);
        }

        console.log('');
        console.log('👉 请在浏览器中随意浏览几个页面，确认没有滑块验证问题');
        await waitForEnter('确认无误后，按 Enter 键关闭浏览器并同步到 ECS...');

        console.log('');
        console.log('🔒 正在关闭浏览器...');
        await browser.close();

        // 等待浏览器完全关闭
        await new Promise(r => setTimeout(r, 2000));

        console.log('');
        console.log('📦 正在同步 userDataDir 到 ECS...');
        console.log(`   源: ${CONFIG.localUserDataDir}`);
        console.log(`   目标: ${CONFIG.ecsHost}:${CONFIG.ecsUserDataDir}`);
        console.log('');

        // 先备份 ECS 上的旧数据
        console.log('⏳ 备份 ECS 旧数据...');
        execSync(`sshpass -p '${CONFIG.ecsPassword}' ssh -o StrictHostKeyChecking=no ${CONFIG.ecsUser}@${CONFIG.ecsHost} "cd /opt/puppeteer-executor && [ -d user_data_agent ] && mv user_data_agent user_data_agent.backup.$(date +%Y%m%d_%H%M%S) || true"`, {
            stdio: 'inherit'
        });

        // 使用 rsync 同步（排除锁文件和临时文件）
        console.log('⏳ 同步 userDataDir（这可能需要几分钟）...');
        execSync(`rsync -avz --progress --exclude='SingletonLock' --exclude='SingletonCookie' --exclude='SingletonSocket' -e "sshpass -p '${CONFIG.ecsPassword}' ssh -o StrictHostKeyChecking=no" "${CONFIG.localUserDataDir}/" ${CONFIG.ecsUser}@${CONFIG.ecsHost}:${CONFIG.ecsUserDataDir}/`, {
            stdio: 'inherit'
        });

        console.log('');
        console.log('✅ 同步完成！');
        console.log('');
        console.log('📝 后续步骤：');
        console.log('   1. ECS 上的 userDataDir 已更新');
        console.log('   2. 重启 ECS 服务：pm2 restart task-server');
        console.log('   3. 测试执行任务，应该不会再出现登录问题');
        console.log('');

    } catch (error) {
        console.error('❌ 错误:', error.message);
        await browser.close();
        process.exit(1);
    }
}

main().catch(console.error);
