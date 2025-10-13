/**
 * @file puppeteer-executor.js
 * @version 21.0 - The Definitive Robustness Fix
 * @description 最终部署版。此版本新增了对“无需滚动”情况的智能判断，当内容可被完整显示时，将直接截图，大大提高了代码的健壮性和通用性。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sharp = require('sharp');
const { TosClient } = require('@volcengine/tos-sdk');

// --- 全局浏览器实例与配置 ---
let browser = null;
const userDataDir = path.join(__dirname, 'user_data_agent');

// --- TOS 客户端初始化 ---
const tosClient = new TosClient({
    accessKeyId: process.env.TOS_ACCESS_KEY_ID,
    accessKeySecret: process.env.TOS_SECRET_ACCESS_KEY,
    endpoint: process.env.TOS_ENDPOINT,
    region: process.env.TOS_REGION,
});

/**
 * 上传文件 Buffer 到 TOS
 */
async function uploadToTOS(buffer, taskId, fileName) {
    const bucketName = process.env.TOS_BUCKET_NAME;
    const objectKey = `automation_screenshots/${taskId}/${fileName}`;
    try {
        await tosClient.putObject({
            bucket: bucketName,
            key: objectKey,
            body: buffer,
            headers: { 'Content-Type': 'image/png' }
        });
        const fileUrl = `https://${bucketName}.${process.env.TOS_ENDPOINT}/${objectKey}`;
        console.log(`[EXECUTOR] 成功上传截图到TOS: ${fileUrl}`);
        return fileUrl;
    } catch (error) {
        console.error(`[EXECUTOR] TOS上传失败: `, error);
        throw new Error(`Failed to upload ${fileName} to TOS.`);
    }
}

/**
 * [终极算法 v12.0 - 健壮性优化]
 */
async function takeStitchedScreenshot(page, selector) {
    console.log('[EXECUTOR] 启用“分段式智能裁剪”终极方案 (v12.0)...');

    const element = await page.waitForSelector(selector, { visible: true, timeout: 15000 });
    if (!element) throw new Error(`长截图失败：找不到元素 ${selector}`);
    
    // --- [核心优化：处理无需滚动的情况] ---
    const { scrollHeight, clientHeight } = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    }, selector);

    if (scrollHeight <= clientHeight) {
        console.log('[EXECUTOR] 元素无需滚动，执行普通截图并返回。');
        return await element.screenshot();
    }
    // --- [优化结束] ---

    const screenshotBuffers = [];
    const overlap = 50; // 定义一个50px的安全重叠区域
    
    // 循环捕获截图
    while (true) {
        screenshotBuffers.push(await element.screenshot());
        const scrollTopBeforeScroll = await page.evaluate(sel => document.querySelector(sel).scrollTop, selector);
        
        await page.evaluate((sel, overlap) => {
            const el = document.querySelector(sel);
            const scrollAmount = Math.max(1, el.clientHeight - overlap);
            el.scrollTop += scrollAmount;
        }, selector, overlap);
        
        try {
            await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 });
        } catch(e) {
            console.warn('[EXECUTOR] 网络静默等待超时，可能已达内容底部。');
        }

        const scrollTopAfterScroll = await page.evaluate(sel => document.querySelector(sel).scrollTop, selector);
        
        if (scrollTopAfterScroll === scrollTopBeforeScroll) {
            console.log('[EXECUTOR] 滚动条位置未再变化，已确认到达内容最终底部。');
            break; 
        }
    }

    console.log(`[EXECUTOR] 已捕获 ${screenshotBuffers.length} 个截图片段，开始像素级拼接...`);
    
    if (screenshotBuffers.length === 0) throw new Error("未能捕获任何截图片段。");
    
    // --- [像素级完美拼接算法 v6.0] ---
    const { finalScrollHeight } = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        return { finalScrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    }, selector);
    
    const firstImage = sharp(screenshotBuffers[0]);
    const { width } = await firstImage.metadata();
    const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
    const scrollHeightInPixels = Math.round(finalScrollHeight * devicePixelRatio);
    const clientHeightInPixels = Math.round(clientHeight * devicePixelRatio);
    const overlapInPixels = Math.round(overlap * devicePixelRatio);
    const scrollStepInPixels = clientHeightInPixels - overlapInPixels;

    const compositeParts = [];
    let composedHeight = 0;

    for (let i = 0; i < screenshotBuffers.length; i++) {
        const isFirst = (i === 0);
        const isLast = (i === screenshotBuffers.length - 1);

        let cropY, cropHeight;

        if (isFirst) {
            // 对于第一张图，只取到重叠区开始前的部分
            cropY = 0;
            cropHeight = scrollStepInPixels;
        } else if (isLast) {
            // 对于最后一张图，计算需要补充的剩余高度
            const remainingHeight = scrollHeightInPixels - composedHeight;
            // 从这张图的底部，向上取剩余高度的内容
            cropY = clientHeightInPixels - remainingHeight;
            cropHeight = remainingHeight;
        } else {
            // 对于中间的图，跳过顶部的重叠区，然后取一个步长的内容
            cropY = overlapInPixels;
            cropHeight = scrollStepInPixels;
        }
        
        // --- 安全检查，防止裁剪区域超出图像边界 ---
        const bufferMetadata = await sharp(screenshotBuffers[i]).metadata();
        if (cropY < 0) { cropY = 0; }
        if (cropY + cropHeight > bufferMetadata.height) {
            cropHeight = bufferMetadata.height - cropY;
        }
        if (cropHeight <= 0) { continue; }

        const croppedBuffer = await sharp(screenshotBuffers[i])
            .extract({ left: 0, top: cropY, width: width, height: cropHeight })
            .toBuffer();
        
        compositeParts.push({ input: croppedBuffer, top: composedHeight, left: 0 });
        composedHeight += cropHeight;
    }
    
    const finalBuffer = await sharp({
        create: {
            width: width,
            // 使用实际拼接的高度，避免因取整误差导致底部出现白边
            height: composedHeight, 
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
    })
    .composite(compositeParts)
    .png()
    .toBuffer();

    console.log('[EXECUTOR] 像素级拼接完成，生成完美长图。');
    return finalBuffer;
}


/**
 * 辅助函数：终极智能靶向滚动 (用于页面主滚动条)
 */
async function autoScroll(page, scrollableElementSelector = null) {
    console.log(`[EXECUTOR] 开始滚动流程，目标区域: ${scrollableElementSelector || '整个页面'}`);
    if (scrollableElementSelector) {
        const element = await page.$(scrollableElementSelector);
        if (element) {
            const boundingBox = await element.boundingBox();
            if (boundingBox) {
                await page.mouse.move(boundingBox.x + boundingBox.width / 2, boundingBox.y + boundingBox.height / 2);
            }
        }
    }
    let retries = 0;
    const maxRetries = 3;
    let lastImageBuffer = null;
    while (retries < maxRetries) {
        const currentImageBuffer = await page.screenshot();
        if (lastImageBuffer && currentImageBuffer.equals(lastImageBuffer)) {
            retries++;
            console.log(`[EXECUTOR] 页面视觉内容未变，尝试次数: ${retries}`);
        } else {
            retries = 0;
        }
        if (retries >= maxRetries) {
            console.log('[EXECUTOR] 页面内容连续未变，判定已到达底部。');
            break;
        }
        lastImageBuffer = currentImageBuffer;
        await page.mouse.wheel({ deltaY: 800 });
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
    console.log('[EXECUTOR] 滚动完成。');
}

/**
 * 辅助函数：智能数据提取引擎
 */
async function extractSingleData(page, selector) {
    let textContent = '';
    if (selector.startsWith('text=') && selector.includes('>> next >>')) {
        const parts = selector.split('>> next >>');
        const textToFind = parts[0].trim().substring(5);
        const childSelector = parts[1].trim();
        textContent = await page.evaluate((text, nextSiblingSelector) => {
            const xpathResult = document.evaluate(`//*[contains(normalize-space(.), "${text}")]`, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            if (xpathResult.snapshotLength === 0) return `Error: 找不到锚点文本 "${text}"`;
            const textElement = xpathResult.snapshotItem(xpathResult.snapshotLength - 1);
            if (!textElement) return `Error: XPath 找到了结果但无法获取锚点元素`;
            let potentialMatch = textElement.nextElementSibling;
            if (!potentialMatch) potentialMatch = textElement.parentElement.nextElementSibling;
            if (!potentialMatch) return `Error: 锚点 "${text}" 没有下一个兄弟元素`;
            const finalElement = potentialMatch.querySelector(nextSiblingSelector) || potentialMatch;
            return finalElement.textContent.trim();
        }, textToFind, childSelector);
    } else if (selector.startsWith('text=') && selector.includes('>>')) {
        const parts = selector.split('>>');
        const textToFind = parts[0].trim().substring(5);
        const childSelector = parts[1].trim();
        textContent = await page.evaluate((text, childSel) => {
            const xpath = `//*[contains(normalize-space(.), "${text}")]`;
            const textResult = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            if (textResult.snapshotLength === 0) return `Error: 找不到包含文本 "${text}" 的元素。`;
            for (let i = textResult.snapshotLength - 1; i >= 0; i--) {
                const textElement = textResult.snapshotItem(i);
                if (!textElement) continue;
                let currentParent = textElement.parentElement;
                while (currentParent && currentParent !== document.body) {
                    const childElement = currentParent.querySelector(childSel);
                    if (childElement) {
                        return childElement.textContent.trim();
                    }
                    currentParent = currentParent.parentElement;
                }
            }
            return `Error: 所有策略均失败。找到了文本 "${text}", 但无法定位到对应的子元素 "${childSel}"。`;
        }, textToFind, childSelector);
    } else {
        await page.waitForSelector(selector, { timeout: 15000, visible: true });
        textContent = await page.$eval(selector, el => el.textContent.trim());
    }
    if (typeof textContent === 'string' && textContent.startsWith('Error:')) {
        throw new Error(textContent);
    }
    return textContent;
}

/**
 * 核心函数：获取或创建浏览器实例
 */
async function getBrowser(isLoginFlow = false) {
    if (browser && browser.isConnected()) {
        return browser;
    }
    const launchOptions = {
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: false,
        userDataDir: userDataDir,
        defaultViewport: null,
        args: ['--start-maximized', '--window-size=2560,1440']
    };
    if (isLoginFlow) {
        console.log('[EXECUTOR] 启动一个新的浏览器实例 (用于登录)...');
    }
    browser = await puppeteer.launch(launchOptions);
    browser.on('disconnected', () => {
        console.log('[EXECUTOR] 浏览器已关闭。');
        browser = null;
    });
    return browser;
}

/**
 * 核心函数：处理登录流程
 */
async function handleLogin() {
    console.log('[EXECUTOR] 启动登录流程...');
    const loginBrowser = await getBrowser(true);
    const page = await loginBrowser.newPage();
    await page.goto('https://www.xingtu.cn/login', { waitUntil: 'networkidle2' });
    return browser;
}

/**
 * 核心函数：执行工作流中的所有步骤
 */
async function executeActions(xingtuId, taskId, workflow) {
    const br = await getBrowser();
    const page = await br.newPage();
    const results = { screenshots: [], data: {} };
    
    try {
        const url = `https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/${xingtuId}`;
        console.log(`[EXECUTOR] 导航至: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        console.log('[EXECUTOR] 等待页面核心内容渲染...');
        await page.waitForSelector('#layout-content', { timeout: 20000, visible: true });
        console.log('[EXECUTOR] 核心内容已渲染，开始执行工作流步骤。');

        for (const step of workflow.steps) {
            console.log(`[EXECUTOR] 执行动作: ${step.action}`, step.description || '');
            
            switch (step.action) {
                case 'wait':
                    await new Promise(resolve => setTimeout(resolve, step.milliseconds || 1000));
                    break;
                case 'waitForSelector':
                    await page.waitForSelector(step.selector, { timeout: 15000, visible: true });
                    break;
                case 'click':
                    await page.waitForSelector(step.selector, { timeout: 15000, visible: true });
                    await page.click(step.selector);
                    break;
                
                case 'screenshot': {
                    let screenshotBuffer;
                    const fileName = step.saveAs || `${Date.now()}_screenshot.png`;
                    if (step.stitched === true) {
                        console.log('[EXECUTOR] 检测到 stitched: true...');
                        screenshotBuffer = await takeStitchedScreenshot(page, step.selector);
                    } else {
                        console.log('[EXECUTOR] 执行“普通截图”模式...');
                        const elementShot = await page.waitForSelector(step.selector, { visible: true, timeout: 15000 });
                        if (!elementShot) throw new Error(`普通截图失败：找不到元素 ${step.selector}`);
                        screenshotBuffer = await elementShot.screenshot();
                    }
                    const screenshotUrl = await uploadToTOS(screenshotBuffer, taskId.toString(), fileName);
                    results.screenshots.push({ name: fileName, url: screenshotUrl });
                    break;
                }
                
                case 'scrollPage':
                    await autoScroll(page, step.selector || null);
                    break;
                case 'waitForNetworkIdle':
                    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 60000 });
                    break;
                case 'extractData':
                    try {
                        const textContent = await extractSingleData(page, step.selector);
                        results.data[step.dataName] = textContent;
                        console.log(`[EXECUTOR] 成功提取数据 '${step.dataName}': ${textContent}`);
                    } catch (e) {
                        console.warn(`[EXECUTOR] 提取数据 '${step.dataName}' 失败: ${e.message}`);
                        results.data[step.dataName] = '提取失败';
                    }
                    break;
                case 'compositeExtract':
                    let template = step.template;
                    for (const source of step.sources) {
                        try {
                            const value = await extractSingleData(page, source.selector);
                            template = template.replace(new RegExp(`\\$\\{${source.name}\\}`, 'g'), value);
                        } catch (e) {
                             console.warn(`[EXECUTOR] 组合数据源 '${source.name}' 提取失败: ${e.message}`);
                             template = template.replace(new RegExp(`\\$\\{${source.name}\\}`, 'g'), '未找到');
                        }
                    }
                    results.data[step.dataName] = template;
                    console.log(`[EXECUTOR] 成功组合数据 '${step.dataName}': ${template.replace(/\n/g, '\\n')}`);
                    break;
            }
        }

        return {
            status: 'completed',
            result: { screenshots: results.screenshots, data: results.data },
            completedAt: new Date()
        };

    } catch (error) {
        console.error(`[EXECUTOR] 执行动作时发生错误:`, error);
        return {
            status: 'failed',
            errorMessage: error.stack,
            failedAt: new Date()
        };
    } finally {
        if (page) await page.close();
    }
}

module.exports = { handleLogin, executeActions };

