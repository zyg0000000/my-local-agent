/**
 * 补丁脚本：修改 local-agent.js 支持自动启动模式
 */
const fs = require('fs');

const filePath = '/opt/puppeteer-executor/local-agent.js';
let content = fs.readFileSync(filePath, 'utf-8');

// 检查是否已经修改过
if (content.includes('服务器模式：自动开始任务处理')) {
    console.log('✅ 已经包含自动启动逻辑，无需修改');
    process.exit(0);
}

// 找到并替换等待 Enter 的代码块
const oldPattern = /const rl = readline\.createInterface\(\{ input: process\.stdin, output: process\.stdout \}\);\s*console\.log\(`\\n\[AGENT\] 请在弹出的浏览器窗口中手动完成扫码登录。`\);\s*console\.log\(`\[AGENT\] 登录成功并跳转到星图后台，请确认浏览器状态。`\);\s*console\.log\(`\[AGENT\] 按 Enter 键开始处理任务\.\.\.`\);\s*await new Promise\(resolve => rl\.question\('', resolve\)\);\s*rl\.close\(\);/;

const newCode = `// 服务器模式自动启动，本地模式等待确认
        if (AUTO_START) {
            console.log(\`\\n[AGENT] 服务器模式：自动开始任务处理...\`);
        } else {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            console.log(\`\\n[AGENT] 请在弹出的浏览器窗口中手动完成扫码登录。\`);
            console.log(\`[AGENT] 登录成功并跳转到星图后台，请确认浏览器状态。\`);
            console.log(\`[AGENT] 按 Enter 键开始处理任务...\`);
            await new Promise(resolve => rl.question('', resolve));
            rl.close();
        }`;

if (oldPattern.test(content)) {
    content = content.replace(oldPattern, newCode);
    fs.writeFileSync(filePath, content);
    console.log('✅ 成功修改 local-agent.js，添加自动启动逻辑');
} else {
    console.log('❌ 未匹配到目标代码块，尝试简单替换...');

    // 备选方案：直接查找并替换关键行
    if (content.includes("按 Enter 键开始处理任务")) {
        content = content.replace(
            "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
            "// 服务器模式自动启动，本地模式等待确认\n        if (AUTO_START) {\n            console.log(`\\n[AGENT] 服务器模式：自动开始任务处理...`);\n        } else {\n            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });"
        );
        content = content.replace(
            "rl.close();",
            "rl.close();\n        }"
        );
        fs.writeFileSync(filePath, content);
        console.log('✅ 使用备选方案修改成功');
    } else {
        console.log('❌ 无法找到需要修改的代码');
        process.exit(1);
    }
}
