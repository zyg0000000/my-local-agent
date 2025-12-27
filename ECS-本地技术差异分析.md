# ECS 线上 vs 本地截图套件：技术差异分析与问题诊断

> 文档创建时间：2025-12-26
> 最后更新：2025-12-27 18:00
> 分析背景：VNC 模式下验证码检测异常、任务执行失败、浏览器崩溃问题

---

## 〇、当前思路总结与待决策点

### 核心问题

**同样的工作流，本地能成功抓取数据，ECS + VNC 处理完验证码后仍然失败。**

---

## 🆕 2025-12-27 更新：userDataDir 问题已解决，浏览器崩溃问题仍存在

### ✅ 已解决：userDataDir 登录状态丢失

**问题现象**：
- 任务卡在步骤 1（导航到达人星图主页）
- 访问星图页面被重定向到登录页（URL 包含 `redirect_uri` 参数）
- 触发风控弹窗提示需要验证

**根本原因**：
ECS 上的 `userDataDir` 登录状态失效了。之前反复调试更换浏览器（Chromium vs Chrome）导致：
1. `/opt/puppeteer-executor/user_data_agent/` 目录内的登录态与当前浏览器不兼容
2. 每次访问都被星图识别为"新设备"，触发风控

**解决方案**：
通过 VNC 在 ECS 上手动登录星图，重新建立有效的 userDataDir：
```bash
# 1. 启动 VNC 服务
nohup Xvfb :99 -screen 0 1920x1080x24 > /dev/null 2>&1 &
nohup x11vnc -display :99 -forever -shared -rfbport 5900 -nopw > /dev/null 2>&1 &
nohup websockify --web=/usr/share/novnc 6080 localhost:5900 > /dev/null 2>&1 &

# 2. 通过 Puppeteer 启动浏览器（使用 userDataDir）
DISPLAY=:99 node vnc-puppeteer-login.js

# 3. 访问 VNC (http://14.103.18.8:6080/vnc.html) 完成手动登录

# 4. 关闭浏览器保存登录状态
```

**验证成功**：headless 模式测试访问达人主页，URL 无 `redirect_uri`，登录状态有效。

### ✅ 已修复：风控弹窗误判

**问题现象**：
每次点击操作后都提示"检测到星图风控弹窗"，但 VNC 中实际没有风控验证。

**根本原因**：
`detectSliderCaptcha()` 函数检测逻辑过于宽泛，只要页面有"取消"和"确定"按钮的模态框就判定为风控。

**解决方案**：
修改检测逻辑，增加风控关键词检查：
```javascript
// 只有包含特定风控关键词的弹窗才认为是风控
const riskKeywords = [
    '风险', '安全验证', '身份验证',
    '获取达人联系方式', '获取联系方式',
    '异常操作', '设备验证'
];
const isRiskControl = riskKeywords.some(keyword => modalText.includes(keyword));
```

### ❌ 仍存在：浏览器在截图步骤崩溃

**问题现象**：
任务在执行到"男女比例截图"（步骤 28/32）附近时，浏览器突然关闭：
```
[EXECUTOR] 执行动作 [28/32]: screenshot 男女比例截图
[EXECUTOR] 执行"普通截图"模式...
[EXECUTOR] 浏览器已关闭。  <-- 没有成功上传就崩溃了
```

**关键观察**：
- 不是每次都崩溃（前两个任务成功，第三个崩溃）
- 不是内存问题（ECS 有 14Gi 可用内存）
- 不是系统 kill（dmesg 无 OOM 记录）
- 与特定达人页面可能有关（成功的是 7211005162712727610，崩溃的是 7053702605167394857）

**待排查方向**：
1. 截图操作本身的问题（内存、渲染、选择器）
2. 某些达人页面的特殊元素导致渲染引擎崩溃
3. 连续执行多个任务后资源累积问题

**建议**：开新对话专门排查此问题，需要增加详细的错误捕获和重试机制。

---

### 已排除的因素

| 因素 | 状态 | 说明 |
|------|------|------|
| 验证码误检测 | ✅ 已修复 | 增加了可见性检查 |
| page null 错误 | ✅ 已修复 | 增加了有效性检查 |
| 滑块验证本身 | ✅ 可处理 | VNC 手动处理没问题 |

### 仍存在的问题

| 问题 | 根因 | 是否可修复 |
|------|------|-----------|
| 选择器超时 | 可能是代码改动引入的 bug | ⚠️ 需排查 |
| 手机验证码 | 机房 IP 被风控 | ❌ 需代理 IP |
| Cookie 注入不完整 | 缺少 LocalStorage 等状态 | ⚠️ 可改进 |

### 关键发现

1. **代码版本差异大**：本地 v22.0 (431行) vs ECS v23.0 (1115行)
2. **Cookie 管理方式不同**：
   - 本地：`user_data_agent/` 目录缓存完整浏览器状态
   - ECS：Cookie 文件注入，缺少 LocalStorage、IndexedDB 等
3. **风控差异**：本地只有滑块，ECS 有滑块+手机验证

### 待决策

**决策 1：ECS 是否值得继续修复？**

| 选项 | 工作量 | 风险 |
|------|--------|------|
| A. 继续修复 v23.0 代码 bug | 2-3天 | 修完可能还有其他问题 |
| B. 让 ECS 用 user_data_agent 目录 | 1天 | 需要 VNC 手动登录一次 |
| C. 放弃 ECS，转本地执行 | 1-2天 | 需要本地电脑在线 |

**决策 2：如果转本地，用什么触发方式？**

| 选项 | 用户体验 | 技术复杂度 |
|------|---------|-----------|
| A. 轮询 MongoDB（现有） | 需要终端操作 | 低，已实现 |
| B. Cloudflare Tunnel + API | 前端点击触发 | 中，需配置 |
| C. 做成 Mac App | 双击启动 | 高，需开发 |

### 建议的验证路径

在做最终决策前，先验证一个假设：

> **假设：ECS 失败是因为 v23.0 代码改坏了，不是环境问题**

验证方法：让 ECS 使用 `user_data_agent` 目录（像本地一样），而不是 Cookie 注入，看是否能成功。

如果成功 → 问题在 Cookie 注入，可以改进
如果失败 → 问题在 v23.0 代码，需要 debug 或回退

---

## 一、版本对比总览

| 维度 | 本地版本 (10.26) | ECS 线上版本 |
|------|-----------------|-------------|
| **puppeteer-executor.js** | v22.0 (431行) | v23.0 (1115行) |
| **浏览器模式** | `headless: false` (有UI) | 无头 + VNC 远程桌面 |
| **验证码处理** | 手动操作滑块 | 自动检测 + 暂停等待 |
| **依赖模块** | 无额外依赖 | cookie-loader, chaojiying, vnc-manager |
| **Cookie 管理** | user_data_agent 目录缓存 | JSON 文件注入 |
| **执行入口** | local-agent.js 轮询 | task-server.js HTTP API |

---

## 二、核心架构差异

### 2.1 本地版本 (v22.0) 架构

```
用户 → 终端运行 npm run watch
         ↓
    local-agent.js (轮询 MongoDB)
         ↓
    puppeteer-executor.js
         ↓
    Chrome 浏览器 (headless: false, 可见窗口)
         ↓
    用户手动处理滑块验证 → 继续执行
```

**特点**：
- 浏览器窗口可见，用户直接操作
- 登录状态保存在 `user_data_agent/` 目录
- 验证码出现时，用户在浏览器中手动滑动
- 简单可靠，无需复杂的暂停/恢复机制

### 2.2 ECS 线上版本 (v23.0) 架构

```
前端 → POST /api/task/execute (enableVNC: true)
         ↓
    task-server.js (HTTP API)
         ↓
    判断 VNC 模式?
    ├── 是 → 启动 VNC 远程桌面 (端口 6080)
    │        启动 executeActionsWithProgress()
    │        SSE 推送实时进度
    │        验证码检测 → 暂停 → 等待 /resume API
    │
    └── 否 → 同步执行 executeActions()
             等待完成后返回结果
         ↓
    puppeteer-executor.js (v23.0)
         ↓
    Chrome 浏览器 (headless: true 或 VNC 模式)
```

**新增能力**：
- `executeActionsWithProgress()` - 带进度回调的执行函数
- `detectSliderCaptcha()` - 验证码检测函数
- `checkAndHandleCaptcha()` - 验证码处理协调函数
- `handleCaptchaWithPause()` - VNC 模式下的暂停机制
- Cookie 文件注入（不依赖 user_data_agent）
- VNC 远程桌面支持

---

## 三、线上遇到的问题

### 问题 1：验证码误检测

**现象**：
```
[CAPTCHA] 检测到 #captcha_container
[CAPTCHA] 验证码容器存在
```
用户在 VNC 中实际没有看到滑块验证码，但 ECS 不断报告检测到验证码。

**原因分析**：
星图网站的 `#captcha_container` 元素**始终存在于 DOM 中**，只是在没有验证码时是隐藏状态（`display: none`）。原始检测逻辑只判断元素是否存在，没有检查可见性。

**尝试的修复**：
```javascript
// 增加可见性检查
const isVisible = await page.evaluate(el => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
}, captchaContainer);
```

**修复后日志确认**：
```
[CAPTCHA] 验证码容器存在但不可见，忽略  ← 修复生效
```

### 问题 2：Cannot read properties of null (reading '$')

**现象**：
```
[CAPTCHA] 检测滑块时出错: Cannot read properties of null (reading '$')
```

**原因分析**：
在某些执行路径下，`page` 对象已经被关闭或为 null，但 `detectSliderCaptcha(page)` 仍被调用，导致 `page.$()` 报错。

**尝试的修复**：
```javascript
async function detectSliderCaptcha(page) {
    // 检查 page 是否有效
    if (!page || page.isClosed()) {
        console.warn('[CAPTCHA] 页面已关闭或无效，跳过验证码检测');
        return false;
    }
    // ...
}
```

### 问题 3：选择器超时失败

**现象**：
```
Error: 点击元素失败 [点击排除广告流量 (完播率)]: Waiting for selector `#layout-content > div > ...` failed
TimeoutError: Waiting failed: 15000ms exceeded
```

**原因分析**：
这是一个复合问题：
1. 工作流中的选择器非常长且脆弱（依赖精确的 DOM 层级）
2. 星图网站页面结构可能发生了变化
3. 页面未完全加载时就开始查找元素

### 问题 4：浏览器突然关闭

**现象**：
```
[EXECUTOR] 等待元素出现: #layout-content > div > ...
[EXECUTOR] 浏览器已关闭。
[EXECUTOR] 浏览器已关闭，下次任务将启动新实例
```

**原因分析**：
当 `waitForSelector` 超时抛出异常后，错误处理逻辑触发了浏览器关闭。在 VNC 模式下，`vnc-manager` 管理着浏览器生命周期，异常导致整个会话终止。

---

## 四、为什么本地没有这些问题？

### 关键差异对比

| 因素 | 本地 (v22.0) | ECS (v23.0) | 影响 |
|------|-------------|-------------|------|
| **验证码检测** | 无自动检测 | 有 `detectSliderCaptcha()` | 本地不会误检测 |
| **浏览器模式** | 有 UI 窗口 | 无头 + VNC | 本地可直接观察和操作 |
| **暂停机制** | 无需暂停 | Promise + resume API | 本地流程简单 |
| **Cookie 管理** | 目录缓存 | 文件注入 | 本地登录更稳定 |
| **执行函数** | `executeActions()` | `executeActionsWithProgress()` | 本地无进度回调复杂度 |

### 本地为什么能正常操作滑块？

1. **浏览器窗口可见**：用户直接看到滑块，手动滑动
2. **无自动检测干扰**：v22.0 没有 `detectSliderCaptcha()`，不会误判
3. **登录状态持久化**：`user_data_agent/` 目录保存了完整的浏览器状态
4. **简单执行流程**：没有 VNC、SSE、暂停/恢复等复杂机制

---

## 五、根本原因分析

### 5.1 两套代码的分叉

```
10月26日 本地版本 (v22.0)
    │
    │   ← 本地保持不变，简单可靠
    │
    ├─────────────────────────────────────
    │
    │   ECS 上进行了大量升级
    ↓
12月 ECS 版本 (v23.0)
    + cookie-loader.js (Cookie 注入)
    + chaojiying.js (超级鹰验证码识别)
    + vnc-manager.js (VNC 远程桌面)
    + executeActionsWithProgress() (进度回调)
    + detectSliderCaptcha() (验证码检测)
    + 双模式支持 (同步 + VNC 异步)
```

### 5.2 问题的本质

ECS v23.0 版本在添加 VNC 模式和验证码自动检测时，引入了复杂的状态管理：

```
问题链：
验证码检测逻辑有缺陷 (只检查存在，不检查可见)
    ↓
误报验证码 → 进入暂停状态
    ↓
page 对象状态异常 (被关闭或为 null)
    ↓
后续操作失败 (选择器超时)
    ↓
异常处理触发浏览器关闭
    ↓
任务失败
```

而本地 v22.0 完全没有这条问题链，因为它：
- 不检测验证码
- 不暂停
- 不管理复杂的 page 生命周期

---

## 六、可选解决方案

### 方案 A：修复 ECS v23.0（复杂度高）

**需要修复的点**：
1. ✅ 验证码可见性检测（已修复）
2. ✅ page null 检查（已修复）
3. ❌ 选择器稳定性（需要更新工作流配置）
4. ❌ 异常处理优化（避免错误导致浏览器关闭）
5. ❌ VNC 模式下的 page 生命周期管理

**优点**：保留 VNC 远程操作能力
**缺点**：改动点多，测试复杂

### 方案 B：回退到本地架构思路

将 ECS 版本简化为类似本地的架构：
- 去掉自动验证码检测
- 使用更简单的执行流程
- VNC 仅用于观察，不用于自动暂停

**优点**：稳定可靠
**缺点**：失去自动化程度，需要人工监控

### 方案 C：分离两套模式

```
模式 1：无头批量模式（非 VNC）
- 用于确定不会出现验证码的任务
- 完全自动化，高吞吐

模式 2：VNC 监控模式
- 用于可能出现验证码的任务
- VNC 仅用于人工观察和干预
- 去掉自动验证码检测逻辑
```

### 方案 D：更新选择器 + 增强容错

1. 更新工作流中过时的选择器
2. 增加选择器找不到时的重试/跳过逻辑
3. 保留现有架构，但增强稳定性

---

## 七、关键发现：ECS 被更严格检测

### 7.1 验证码差异

| 环境 | 验证码类型 | 原因分析 |
|------|-----------|---------|
| **本地 Mac** | 仅滑块验证 | 住宅 IP、真实浏览器环境 |
| **ECS 服务器** | 滑块 + 手机验证 | 机房 IP、被识别为自动化 |

### 7.2 为什么 ECS 被更严格检测？

星图网站可能通过以下方式识别 ECS 环境：

1. **IP 信誉度**
   - ECS 使用的是云服务商机房 IP（14.103.18.8）
   - 这类 IP 经常被用于爬虫/自动化，容易被标记
   - 本地使用住宅宽带 IP，信誉度更高

2. **浏览器指纹**
   - ECS 的 Chrome 可能缺少某些本地浏览器特征
   - User-Agent、WebGL、Canvas 指纹等可能暴露自动化

3. **行为特征**
   - ECS headless 模式的行为模式与真人不同
   - 即使用了 VNC，底层仍然是 Puppeteer 控制

4. **Cookie 来源不一致**
   - 本地 Cookie 是在同一浏览器环境生成的
   - ECS Cookie 是从其他环境导入的，可能触发风控

### 7.3 这意味着什么？

**即使修复了代码层面的所有 bug，ECS 仍可能持续触发手机验证**，因为这是服务端风控策略，不是代码问题。

---

## 八、解决方案深度分析

### 方案 A：继续修复 ECS（不推荐）

**可行性：低**

即使修复所有代码问题：
- 选择器超时 → 可修复
- 验证码误检测 → 已修复
- page null 错误 → 已修复

**但无法解决**：
- 机房 IP 被风控 → 需要代理 IP
- 手机验证 → 需要接码平台
- 复杂度急剧上升，成本增加

**预估工作量**：
- 代理 IP 池接入：3-5 天
- 接码平台接入：2-3 天
- 超级鹰滑块识别：2-3 天
- 测试调优：3-5 天
- **总计：10-16 天**

### 方案 B：本地运行 + 远程触发（推荐）

**核心思路**：保留远程触发能力，但实际执行在本地

```
前端 → API 触发
         ↓
    本地服务监听任务（local-agent.js 或 task-server.js）
         ↓
    本地 Chrome 执行（headless: false）
         ↓
    验证码时人工处理滑块
         ↓
    结果回传到数据库/API
```

**实现方式**：

1. **Cloudflare Tunnel 方案**
   - 本地运行 cloudflared
   - 暴露 task-server.js 的 3001 端口
   - 前端通过 Cloudflare 域名调用本地服务
   - 已有先例：根据 `13a4c3b docs: 记录 Cloudflare Tunnel HTTPS 配置`

2. **内网穿透方案**
   - 使用 ngrok、frp 等工具
   - 类似 Cloudflare Tunnel

**优点**：
- 使用住宅 IP，风控概率大幅降低
- 验证码只有滑块，可手动处理
- 保留前端远程触发能力
- 代码改动最小

**缺点**：
- 需要本地电脑保持开机
- 不能完全无人值守（偶尔需要处理滑块）

### 方案 C：混合模式

```
日常任务 → 本地执行（方案 B）
特殊情况 → ECS 备用（当本地不可用时）
```

---

## 九、推荐决策

### 短期（立即可行）

**采用方案 B：本地运行 + Cloudflare Tunnel**

1. 本地运行 `npm run watch` 或启动 `task-server.js`
2. 通过 Cloudflare Tunnel 暴露本地服务
3. 前端调用本地服务 API
4. 验证码时手动处理滑块

### 长期考虑

如果未来需要完全无人值守：
- 评估代理 IP + 接码平台的成本
- 考虑是否值得投入 10-16 天开发时间

---

## 十、关键文件路径

```
本地：
/Users/yigongzhang/字节专用程序/截图套件/
├── puppeteer-executor.js  (v22.0, 431行)
├── local-agent.js         (v3.2, 249行)
├── task-server.js         (v3.0, 539行)
└── user_data_agent/       (浏览器状态缓存)

ECS：
/opt/puppeteer-executor/
├── puppeteer-executor.js  (v23.0, 1115行)
├── task-server.js         (v3.0)
├── cookie-loader.js       (Cookie 注入)
├── chaojiying.js          (超级鹰 API)
├── vnc-manager.js         (VNC 管理)
└── xingtu-cookies.json    (Cookie 文件)
```
