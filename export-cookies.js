const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

(async () => {
    const userDataDir = path.join(__dirname, 'user_data_agent');

    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
        userDataDir: userDataDir,
    });

    const page = await browser.newPage();

    // 访问星图获取 Cookie
    await page.goto('https://www.xingtu.cn', { waitUntil: 'networkidle2' });

    // 获取所有 Cookie
    const cookies = await page.cookies('https://www.xingtu.cn');

    // 保存到文件
    fs.writeFileSync(
        path.join(__dirname, 'xingtu-cookies.json'),
        JSON.stringify(cookies, null, 2)
    );

    console.log(`导出了 ${cookies.length} 个 Cookie 到 xingtu-cookies.json`);
    console.log('关键 Cookie:');
    cookies.filter(c => c.name.includes('session') || c.name.includes('sid')).forEach(c => {
        console.log(`  - ${c.name}: ${c.value.substring(0, 20)}...`);
    });

    await browser.close();
})();
