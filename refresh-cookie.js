/**
 * refresh-cookie.js
 * 本地登录脚本：打开浏览器 → 用户手动登录 → 导出 Cookie → 上传到 ECS
 *
 * 使用方法：node refresh-cookie.js
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// 配置
const CONFIG = {
    // 星图登录页
    loginUrl: 'https://www.xingtu.cn/login',
    // 登录成功后会跳转到的页面
    successUrlPattern: /xingtu\.cn\/(gw|ad|supplier)/,
    // Cookie 输出文件
    cookieFile: path.join(__dirname, 'xingtu-cookies.json'),
    // ECS 服务器配置
    ecsHost: '14.103.18.8',
    ecsUser: 'root',
    ecsPassword: '64223902Kz',
    ecsPath: '/opt/puppeteer-executor/xingtu-cookies.json',
    // 超时时间（5分钟，给用户足够时间处理滑块）
    timeout: 5 * 60 * 1000
};

/**
 * 等待用户按 Enter 键
 */
function waitForEnter() {
    return new Promise(resolve => {
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question('', () => {
            rl.close();
            resolve();
        });
    });
}

/**
 * 主流程
 */
async function main() {
    console.log('='.repeat(50));
    console.log('🚀 星图 Cookie 刷新工具');
    console.log('='.repeat(50));
    console.log('');
    console.log('📋 使用说明：');
    console.log('   1. 浏览器会自动打开星图登录页');
    console.log('   2. 请手动输入邮箱和密码');
    console.log('   3. 如果出现滑块验证，请手动完成');
    console.log('   4. 登录成功后，脚本会自动导出 Cookie 并上传到 ECS');
    console.log('');
    console.log('⏳ 正在启动浏览器...');

    const browser = await puppeteer.launch({
        headless: false,  // 显示浏览器窗口
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        defaultViewport: { width: 1280, height: 800 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    try {
        const page = await browser.newPage();

        // 设置 User-Agent，避免被检测
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // 导航到登录页
        console.log('📍 正在打开星图登录页...');
        await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle2' });

        console.log('');
        console.log('👆 请在浏览器中完成登录操作');
        console.log('   （等待登录成功，最长等待 5 分钟）');
        console.log('');

        // 等待登录成功（URL 变化）
        await page.waitForFunction(
            (pattern) => new RegExp(pattern).test(window.location.href),
            { timeout: CONFIG.timeout },
            CONFIG.successUrlPattern.source
        );

        console.log('✅ 检测到登录成功！');
        console.log('');
        console.log('👉 请在浏览器中随意浏览，确认没有滑块验证问题');
        console.log('   确认无误后，按 Enter 键导出 Cookie...');
        console.log('');

        // 等待用户按 Enter 确认
        await waitForEnter();

        // 导出 Cookie
        console.log('📦 正在导出 Cookie...');
        const cookies = await page.cookies();

        // 保存到本地文件
        fs.writeFileSync(CONFIG.cookieFile, JSON.stringify(cookies, null, 2));
        console.log(`   ✅ 已保存到: ${CONFIG.cookieFile}`);
        console.log(`   📊 Cookie 数量: ${cookies.length}`);

        // 检查关键 Cookie
        const sessionCookie = cookies.find(c => c.name === 'sessionid' || c.name === 'passport_csrf_token');
        if (sessionCookie && sessionCookie.expires) {
            const expiresAt = new Date(sessionCookie.expires * 1000);
            const daysUntilExpiry = Math.floor((expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
            console.log(`   📅 有效期: ${daysUntilExpiry} 天 (到 ${expiresAt.toLocaleDateString()})`);
        }

        console.log('');

        // 上传到 ECS
        console.log('☁️  正在上传到 ECS 服务器...');
        await uploadToECS();

        console.log('');
        console.log('='.repeat(50));
        console.log('🎉 Cookie 刷新完成！');
        console.log('='.repeat(50));

    } catch (error) {
        if (error.name === 'TimeoutError') {
            console.error('❌ 超时：登录等待时间超过 5 分钟');
        } else {
            console.error('❌ 错误:', error.message);
        }
        process.exit(1);
    } finally {
        await browser.close();
    }
}

/**
 * 通过 SCP 上传 Cookie 到 ECS
 */
async function uploadToECS() {
    const { execSync } = require('child_process');

    try {
        // 使用 sshpass + scp 上传
        const scpCommand = `sshpass -p '${CONFIG.ecsPassword}' scp -o StrictHostKeyChecking=no "${CONFIG.cookieFile}" ${CONFIG.ecsUser}@${CONFIG.ecsHost}:${CONFIG.ecsPath}`;

        execSync(scpCommand, { stdio: 'pipe' });
        console.log('   ✅ 上传成功！');

        // 验证上传
        const verifyCommand = `sshpass -p '${CONFIG.ecsPassword}' ssh -o StrictHostKeyChecking=no ${CONFIG.ecsUser}@${CONFIG.ecsHost} "ls -la ${CONFIG.ecsPath} && echo '---' && head -c 100 ${CONFIG.ecsPath}"`;
        const result = execSync(verifyCommand, { encoding: 'utf-8' });
        console.log('   📄 ECS 文件信息:');
        console.log('   ' + result.split('\n')[0]);

    } catch (error) {
        console.error('   ⚠️  SCP 上传失败:', error.message);
        console.log('');
        console.log('   💡 备选方案：手动上传');
        console.log(`      scp "${CONFIG.cookieFile}" ${CONFIG.ecsUser}@${CONFIG.ecsHost}:${CONFIG.ecsPath}`);
    }
}

// 运行
main();
