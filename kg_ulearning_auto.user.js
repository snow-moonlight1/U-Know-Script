// ==UserScript==
// @name         优学院知识图谱 - 全自动满分刷题调度器 (防风控增强版)
// @namespace    kg.ulearning.auto.v3
// @version      3.1.0
// @description  拦截第一次"去测验"请求作为引擎点火，随后在后台全自动递归刷完整个知识图谱的所有测验。纯API方案，内置幽灵请求链、动态字数耗时、紧急停止、幂等跳过功能。
// @author       Antigravity & User
// @match        *://kg.ulearning.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ★ 必须在任何重写之前第一时间保存原生 fetch，供 apiFetch 在任何时机调用
    const originalFetch = window.fetch.bind(window);

    // ============================================================
    //  全局状态
    // ============================================================
    let capturedToken    = null;   // 窃取到的 Authorization Token
    let schedulerRunning = false;  // 调度器是否正在运行（防止重复点火）
    let completedCount   = 0;     // 已完成的知识点数量
    let skippedCount     = 0;     // ★ [v3.1] 跳过的已满分知识点数量

    // ★ [新增] 紧急停止标志位 —— Kill Switch
    let isAborted = false;

    // ★ [v3.1] 强制重刷开关状态（跨 DOM 重建持久化）
    let forceRebrush = false;

    // ============================================================
    //  工具函数
    // ============================================================

    /** 安全睡眠 —— 每 500ms 检查一次 isAborted，支持提前退出 */
    function sleep(ms) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                if (isAborted) {
                    reject(new AbortError('用户已按下紧急停止'));
                    return;
                }
                const elapsed = Date.now() - start;
                if (elapsed >= ms) {
                    resolve();
                } else {
                    setTimeout(check, Math.min(500, ms - elapsed));
                }
            };
            check();
        });
    }

    /** 自定义 AbortError 类型，用于区分主动终止和真实错误 */
    class AbortError extends Error {
        constructor(msg) {
            super(msg);
            this.name = 'AbortError';
        }
    }

    /** 检查中断标志，若已中断则抛出 AbortError */
    function checkAbort() {
        if (isAborted) throw new AbortError('用户已按下紧急停止');
    }

    /**
     * ★ [新增] 高斯随机数生成器 (Box-Muller 变换)
     * 返回一个在 [min, max] 范围内近似正态分布的随机数
     * 均值为 (min+max)/2，标准差为 (max-min)/6（99.7% 落在范围内）
     */
    function randomGaussian(min, max) {
        let u = 0, v = 0;
        while (u === 0) u = Math.random(); // 排除 0
        while (v === 0) v = Math.random();
        // Box-Muller 变换
        const stdNormal = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        const mean = (min + max) / 2;
        const stdDev = (max - min) / 6;
        const result = mean + stdDev * stdNormal;
        // 钳制到 [min, max] 范围
        return Math.max(min, Math.min(max, result));
    }

    /** 随机整数 [min, max]（均匀分布，用于简单延迟） */
    function randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    /**
     * ★ [新增] 从题目列表中提取总文本字数
     * 优先读取 title / name 字段，去除 HTML 标签后统计字符数
     * 若无法提取文本，按 题目数 * 50 估算
     */
    function extractTotalCharCount(questionList) {
        let totalText = '';
        for (const q of questionList) {
            const raw = q.title || q.name || '';
            // 去除 HTML 标签
            const cleaned = raw.replace(/<[^>]*>/g, '').trim();
            totalText += cleaned;
            // 也把选项文本加进来
            if (Array.isArray(q.item)) {
                for (const opt of q.item) {
                    totalText += (opt.title || '').replace(/<[^>]*>/g, '').trim();
                }
            }
        }
        if (totalText.length === 0) {
            return questionList.length * 50; // 保底估算
        }
        return totalText.length;
    }

    /**
     * ★ [新增] 计算动态答题延迟（秒）
     * 基于：阅读时间 + 每题思考时间（高斯随机）
     * 人类阅读速度假设：300字/分 = 5字/秒
     */
    function calculateAnswerDelay(questionList) {
        const charCount = extractTotalCharCount(questionList);
        const readingTimeSec = charCount / 5; // 基础阅读时间
        // 每道题额外 2~5 秒思考时间（高斯分布）
        let thinkingTime = 0;
        for (let i = 0; i < questionList.length; i++) {
            thinkingTime += randomGaussian(2, 5);
        }
        const totalSec = readingTimeSec + thinkingTime;
        // 加一个整体小扰动 ±10%
        const jitter = totalSec * (Math.random() * 0.2 - 0.1);
        return Math.max(5, Math.round(totalSec + jitter)); // 最少 5 秒
    }


    // ============================================================
    //  UI: Toast 浮动通知
    // ============================================================
    function injectStyles() {
        if (document.getElementById('kg-auto-style')) return;
        const style = document.createElement('style');
        style.id = 'kg-auto-style';
        style.textContent = `
            #kg-toast-wrap {
                position: fixed; top: 20px; right: 20px; z-index: 2147483647;
                display: flex; flex-direction: column; gap: 10px; pointer-events: none;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            }
            .kg-toast {
                padding: 13px 18px; border-radius: 12px; color: #fff; pointer-events: all;
                font-size: 13.5px; font-weight: 500; min-width: 280px; max-width: 360px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.22); line-height: 1.5;
                display: flex; align-items: flex-start; gap: 9px;
                animation: kg-in 0.35s cubic-bezier(.21,1.02,.73,1) forwards;
            }
            .kg-toast.out { animation: kg-out 0.3s ease forwards; }
            .kg-toast .kg-icon { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
            .kg-toast .kg-body { flex: 1; }
            .kg-toast .kg-title { font-weight: 700; margin-bottom: 2px; }
            .kg-toast .kg-sub   { opacity: 0.88; font-size: 12.5px; }
            .kg-toast.info    { background: linear-gradient(135deg, #4776e6, #8e54e9); }
            .kg-toast.success { background: linear-gradient(135deg, #11998e, #38ef7d); color: #0a3d2e; }
            .kg-toast.error   { background: linear-gradient(135deg, #f7971e, #f6523b); }
            .kg-toast.warning { background: linear-gradient(135deg, #f7971e, #ffd200); color: #3d2800; }

            #kg-panel {
                position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
                background: rgba(20,20,30,0.92); backdrop-filter: blur(12px);
                border: 1px solid rgba(255,255,255,0.12); border-radius: 16px;
                padding: 16px 20px; color: #fff; min-width: 260px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,0.35);
                animation: kg-in 0.4s cubic-bezier(.21,1.02,.73,1) forwards;
            }
            #kg-panel .kg-panel-title {
                font-size: 14px; font-weight: 700;
                background: linear-gradient(90deg, #a78bfa, #60a5fa);
                -webkit-background-clip: text; -webkit-text-fill-color: transparent;
                margin-bottom: 10px;
            }
            #kg-panel .kg-row { display: flex; justify-content: space-between; margin: 5px 0; opacity: 0.85; }
            #kg-panel .kg-val { font-weight: 600; color: #7dd3fc; }
            #kg-panel .kg-progress-bar-wrap {
                background: rgba(255,255,255,0.1); border-radius: 99px;
                height: 6px; margin-top: 12px; overflow: hidden;
            }
            #kg-panel .kg-progress-bar {
                height: 100%; border-radius: 99px;
                background: linear-gradient(90deg, #a78bfa, #60a5fa);
                transition: width 0.6s ease;
            }

            /* ★ [新增] 紧急停止按钮样式 */
            #kg-kill-switch {
                display: block; width: 100%; margin-top: 14px; padding: 9px 0;
                border: none; border-radius: 10px; cursor: pointer;
                font-size: 13px; font-weight: 700; color: #fff;
                background: linear-gradient(135deg, #ef4444, #dc2626);
                box-shadow: 0 4px 14px rgba(239,68,68,0.4);
                transition: all 0.2s ease;
                letter-spacing: 0.5px;
            }
            #kg-kill-switch:hover {
                background: linear-gradient(135deg, #dc2626, #b91c1c);
                box-shadow: 0 6px 20px rgba(239,68,68,0.55);
                transform: translateY(-1px);
            }
            #kg-kill-switch:active {
                transform: translateY(0);
                box-shadow: 0 2px 8px rgba(239,68,68,0.3);
            }
            #kg-kill-switch:disabled {
                opacity: 0.5; cursor: not-allowed;
                transform: none;
            }

            /* ★ [新增] 倒计时显示样式 */
            #kg-countdown-row .kg-val {
                color: #fbbf24 !important;
                font-variant-numeric: tabular-nums;
            }

            @keyframes kg-in  { from { transform: translateX(60px) scale(0.92); opacity:0; } to { transform: none; opacity:1; } }
            @keyframes kg-out { from { transform: none; opacity:1; } to { transform: translateX(60px) scale(0.92); opacity:0; } }

            /* ★ [新增] 脉冲呼吸动画（用于答题模拟时状态行） */
            @keyframes kg-pulse {
                0%, 100% { opacity: 0.85; }
                50% { opacity: 1; }
            }
            .kg-pulsing { animation: kg-pulse 1.5s ease-in-out infinite; }

            /* ★ [v3.1] 强制重刷复选框样式 */
            #kg-force-rebrush-wrap {
                display: flex; align-items: center; gap: 8px;
                margin-top: 10px; padding: 8px 10px;
                background: rgba(255,255,255,0.05); border-radius: 8px;
                border: 1px solid rgba(255,255,255,0.08);
                cursor: pointer; user-select: none;
                transition: background 0.2s ease;
            }
            #kg-force-rebrush-wrap:hover {
                background: rgba(255,255,255,0.1);
            }
            #kg-force-rebrush {
                width: 15px; height: 15px; cursor: pointer;
                accent-color: #a78bfa;
                margin: 0;
            }
            #kg-force-rebrush-wrap label {
                font-size: 12px; opacity: 0.8; cursor: pointer;
                color: #e2e8f0; line-height: 1.3;
            }

            /* ★ [v3.1] 跳过计数样式 */
            .kg-skip-val { color: #a78bfa !important; }
        `;
        document.head.appendChild(style);
    }

    function getToastContainer() {
        if (!document.getElementById('kg-toast-wrap')) {
            const wrap = document.createElement('div');
            wrap.id = 'kg-toast-wrap';
            document.body.appendChild(wrap);
        }
        return document.getElementById('kg-toast-wrap');
    }

    function showToast(title, sub = '', type = 'info', duration = 4000) {
        injectStyles();
        const wrap = getToastContainer();
        const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
        const el = document.createElement('div');
        el.className = `kg-toast ${type}`;
        el.innerHTML = `
            <span class="kg-icon">${icons[type] || 'ℹ️'}</span>
            <div class="kg-body">
                <div class="kg-title">${title}</div>
                ${sub ? `<div class="kg-sub">${sub}</div>` : ''}
            </div>`;
        wrap.appendChild(el);
        setTimeout(() => {
            el.classList.add('out');
            setTimeout(() => el.remove(), 300);
        }, duration);
    }

    // ============================================================
    //  UI: 进度面板（右下角常驻）—— ★ 增强版，含停止按钮 & 倒计时
    // ============================================================
    let panelEl = null;

    /**
     * 显示/更新进度面板
     * @param {string} statusText  - 当前状态文字
     * @param {number} count       - 已完成知识点数
     * @param {string} knowledgeName - 当前知识点名称
     * @param {number} countdown   - 倒计时秒数（≤0 时不显示倒计时行）
     * @param {boolean} pulsing    - 状态行是否启用呼吸动画
     */
    function showPanel(statusText, count, knowledgeName = '', countdown = 0, pulsing = false) {
        injectStyles();
        if (!panelEl) {
            panelEl = document.createElement('div');
            panelEl.id = 'kg-panel';
            document.body.appendChild(panelEl);
        }

        const countdownRow = countdown > 0
            ? `<div class="kg-row ${pulsing ? 'kg-pulsing' : ''}" id="kg-countdown-row">
                   <span>⏱ 模拟答题中</span>
                   <span class="kg-val">剩余 ${countdown} 秒</span>
               </div>`
            : '';

        const abortedLabel = isAborted
            ? `<div class="kg-row" style="color:#ef4444;font-weight:700;"><span>⚠ 已安全终止</span></div>`
            : '';

        // ★ [v3.1] 跳过计数行（仅在有跳过时显示）
        const skipRow = skippedCount > 0
            ? `<div class="kg-row"><span>已跳过</span><span class="kg-val kg-skip-val">${skippedCount} 个已满分</span></div>`
            : '';

        panelEl.innerHTML = `
            <div class="kg-panel-title">⚡ 知识图谱全自动刷题</div>
            <div class="kg-row ${pulsing && countdown <= 0 ? 'kg-pulsing' : ''}">
                <span>状态</span><span class="kg-val">${statusText}</span>
            </div>
            <div class="kg-row"><span>已完成</span><span class="kg-val">${count} 个知识点</span></div>
            ${skipRow}
            ${knowledgeName ? `<div class="kg-row"><span>当前</span><span class="kg-val" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${knowledgeName}</span></div>` : ''}
            ${countdownRow}
            ${abortedLabel}
            <div class="kg-progress-bar-wrap">
                <div class="kg-progress-bar" style="width:${Math.min(count * 10, 100)}%"></div>
            </div>
            <div id="kg-force-rebrush-wrap">
                <input type="checkbox" id="kg-force-rebrush" ${forceRebrush ? 'checked' : ''} />
                <label for="kg-force-rebrush">强制重刷已满分测验</label>
            </div>
            <button id="kg-kill-switch" ${isAborted || !schedulerRunning ? 'disabled' : ''}>⏹ 停止刷题</button>
        `;

        // ★ [v3.1] 绑定强制重刷复选框事件（将状态持久化到闭包变量）
        const checkbox = document.getElementById('kg-force-rebrush');
        if (checkbox) {
            checkbox.addEventListener('change', () => {
                forceRebrush = checkbox.checked;
                console.log(`[KG-Auto] 🔄 强制重刷开关: ${forceRebrush ? '开启' : '关闭'}`);
            });
        }

        // 绑定停止按钮事件
        const btn = document.getElementById('kg-kill-switch');
        if (btn && !isAborted) {
            btn.addEventListener('click', () => {
                isAborted = true;
                btn.disabled = true;
                btn.textContent = '⏹ 正在停止…';
                showToast('🛑 紧急停止已触发', '脚本将在当前操作完成后安全退出', 'warning', 5000);
                console.log('[KG-Auto] 🛑 用户触发紧急停止 (Kill Switch)');
            });
        }
    }

    /** 仅更新倒计时数字，避免频繁重建 DOM */
    function updateCountdown(seconds) {
        const row = document.getElementById('kg-countdown-row');
        if (row) {
            const valSpan = row.querySelector('.kg-val');
            if (valSpan) valSpan.textContent = `剩余 ${seconds} 秒`;
        }
    }

    function hidePanel() {
        if (panelEl) { panelEl.remove(); panelEl = null; }
    }

    // ============================================================
    //  API 调用封装（使用闭包顶部保存的原生 fetch，永不受 Hook 影响）
    // ============================================================
    function apiFetch(url, options = {}) {
        checkAbort(); // ★ 每次网络请求前检查中断
        return originalFetch(url, {
            credentials: 'include',
            ...options,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Authorization': capturedToken,
                'Origin': 'https://kg.ulearning.cn',
                'Referer': 'https://kg.ulearning.cn/',
                ...options.headers,
            }
        });
    }

    // ============================================================
    //  ★ [v3.1 重构] 幽灵请求（Ghost Fetching）—— 拆分为两阶段
    //  正常用户的 API 调用链：
    //    Phase 1: GET /knowledge/studentKnowledgeInfo/{id}  → 查看知识点详情页
    //             (返回 masteryLevel，用于幂等跳过判断)
    //    Phase 2: GET /resourceRelation/listByKnowledgeId    → 加载视频/资源列表
    //             (仅在需要答题时执行，已满分则跳过)
    //    Phase 3: GET /questionRelation/quizList             → 点击"去测验"
    //
    //  风控依赖 Nginx 日志检查：是否跳过了步骤 1、2
    // ============================================================

    /**
     * 幽灵请求 Phase 1 —— 获取知识点详情，提取 masteryLevel
     * 这是每个知识点都必须执行的请求（即使跳过也要发，因为真实用户也会触发）
     * @param {number} knowledgeId - 目标知识点 ID
     * @returns {Promise<number>} masteryLevel（0.0 ~ 1.0）
     */
    async function ghostFetchInfo(knowledgeId) {
        console.log(`[KG-Auto] 👻 Phase 1: studentKnowledgeInfo → knowledgeId=${knowledgeId}`);
        checkAbort();
        showPanel('👻 模拟浏览…', completedCount, `加载知识点 #${knowledgeId}`, 0, true);

        const infoRes = await apiFetch(
            `https://knowledgeapi.ulearning.cn/knowledge/studentKnowledgeInfo/${knowledgeId}`
        );
        const infoData = await infoRes.json();

        const masteryLevel = (infoData.code === 1 && infoData.result)
            ? (infoData.result.masteryLevel || 0)
            : 0;
        const knowledgeName = (infoData.code === 1 && infoData.result)
            ? (infoData.result.name || '')
            : '';

        console.log(`[KG-Auto] 👻 studentKnowledgeInfo → masteryLevel=${masteryLevel} (${knowledgeName})`);

        // 随机等待 800ms ~ 1500ms（模拟用户阅读知识点概要）
        const delay1 = randomInt(800, 1500);
        console.log(`[KG-Auto] 👻 等待 ${delay1}ms（模拟阅读知识点概要）`);
        await sleep(delay1);

        return masteryLevel;
    }

    /**
     * 幽灵请求 Phase 2 —— 加载资源/视频列表并等待
     * 仅在需要答题时执行（已满分跳过时不需要此请求）
     * @param {number} knowledgeId - 目标知识点 ID
     */
    async function ghostFetchResources(knowledgeId) {
        console.log(`[KG-Auto] 👻 Phase 2: listByKnowledgeId → knowledgeId=${knowledgeId}`);
        checkAbort();
        showPanel('👻 模拟浏览…', completedCount, `加载资源列表 #${knowledgeId}`, 0, true);

        const listRes = await apiFetch(
            `https://knowledgeapi.ulearning.cn/resourceRelation/listByKnowledgeId?knowledgeId=${knowledgeId}&pn=1&ps=9999`
        );
        const listData = await listRes.json();
        console.log(`[KG-Auto] 👻 listByKnowledgeId → 收到 ${listData.list ? listData.list.length : 0} 个资源`);

        // 随机等待 1500ms ~ 3000ms（模拟在视频页面的短暂停留）
        const delay2 = randomInt(1500, 3000);
        console.log(`[KG-Auto] 👻 等待 ${delay2}ms（模拟视频页停留）`);
        await sleep(delay2);

        console.log(`[KG-Auto] 👻 Phase 2 完成 → 即将拉取 quizList`);
    }


    // ============================================================
    //  API 业务函数
    // ============================================================

    /** 获取某个知识点的测验题目列表 */
    async function fetchQuizList(knowledgeId) {
        checkAbort();
        const res = await apiFetch(
            `https://knowledgeapi.ulearning.cn/questionRelation/quizList?knowledgeId=${knowledgeId}`
        );
        const data = await res.json();
        if (data.code !== 1) throw new Error(`quizList 接口返回异常: ${data.message}`);
        return data.result; // { list: [...], nextKnowledge: {...} }
    }

    /** 提交满分答案 */
    async function submitFullScore(knowledgeId, questionList) {
        checkAbort();
        const payload = {
            knowledgeId: knowledgeId,
            answerResultsModels: questionList.map(q => ({
                questionId: q.questionid,
                results: 1   // 全部答对
            }))
        };
        const res = await apiFetch('https://knowledgeapi.ulearning.cn/questionRelation/quizResults', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.code !== 1) throw new Error(`quizResults 接口返回异常: ${data.message}`);
        return data.result; // 返回得分率浮点数，如 1.0000
    }


    // ============================================================
    //  ★ [新增] 模拟答题延迟 —— 带 UI 倒计时
    //  在 quizList 获取后、submitFullScore 之前执行
    //  通过动态字数耗时对抗时间戳风控
    // ============================================================

    /**
     * 执行模拟答题延迟，在面板上显示倒计时
     * @param {Array} questionList - 题目列表
     * @param {string} knowledgeName - 当前知识点名
     */
    async function simulateAnsweringDelay(questionList, knowledgeName) {
        if (questionList.length === 0) return;

        const totalDelaySec = calculateAnswerDelay(questionList);
        console.log(`[KG-Auto] ⏱ 模拟答题延迟: ${totalDelaySec}s（${questionList.length} 题，${extractTotalCharCount(questionList)} 字）`);

        // 初始显示倒计时面板
        showPanel('📝 模拟答题中…', completedCount, knowledgeName, totalDelaySec, true);

        // 每秒更新倒计时
        for (let remaining = totalDelaySec; remaining > 0; remaining--) {
            checkAbort();
            updateCountdown(remaining);
            await sleep(1000);
        }

        console.log(`[KG-Auto] ⏱ 答题延迟完成，准备提交`);
    }


    // ============================================================
    //  核心调度器：autoBrush 递归引擎 —— ★ v3.1 幂等重构版
    //
    //  执行流程（每个知识点）：
    //    Step A: 幽灵请求 Phase 1 → 获取 masteryLevel
    //    Step B: 幂等判断 → 已满分且未勾选强制重刷 → 跳过
    //    Step C: 幽灵请求 Phase 2 → 加载资源列表（仅答题分支）
    //    Step D: 拉取 quizList
    //    Step E: 模拟答题延迟
    //    Step F: 满分交卷
    //    Step G: 递归到下一关
    // ============================================================
    async function autoBrush(knowledgeId, questionList, nextKnowledgeId, knowledgeName = '') {
        try {
            // ── 步骤 A：模拟答题延迟（基于字数的动态耗时）────
            if (questionList.length > 0) {
                await simulateAnsweringDelay(questionList, knowledgeName);
            }

            // ── 步骤 B：满分交卷 ──────────────────────────────
            checkAbort();
            console.log(`[KG-Auto] ▶ 正在提交 knowledgeId=${knowledgeId}（${questionList.length} 题）`);
            showPanel('🔥 提交答案…', completedCount, knowledgeName);

            if (questionList.length > 0) {
                const scoreRate = await submitFullScore(knowledgeId, questionList);
                completedCount++;
                const scorePercent = (scoreRate * 100).toFixed(0);
                console.log(`[KG-Auto] ✅ knowledgeId=${knowledgeId} 提交完成，得分率 ${scorePercent}%`);
                showToast(
                    `✅ ${knowledgeName || `知识点 #${knowledgeId}`}`,
                    `得分率 ${scorePercent}%  |  已完成 ${completedCount} 个`,
                    scoreRate >= 1 ? 'success' : 'warning',
                    3000
                );
            } else {
                console.log(`[KG-Auto] ⏭ knowledgeId=${knowledgeId} 没有题目，跳过提交`);
                completedCount++;
            }

            // ── 步骤 C：判断是否还有下一关 ───────────────────
            checkAbort();
            if (!nextKnowledgeId) {
                onAllDone();
                return;
            }

            // ── 步骤 D：★ [v3.1] 幽灵请求 Phase 1 → 获取 masteryLevel ──
            //    无论是否跳过，studentKnowledgeInfo 都必须请求（Nginx 日志完整性）
            const masteryLevel = await ghostFetchInfo(nextKnowledgeId);

            // ── 步骤 E：★ [v3.1] 幂等判断 —— 读取强制重刷开关 ──
            const isForceRebrush = forceRebrush; // 读取全局状态（由 checkbox 实时更新）
            const isAlreadyMastered = masteryLevel >= 1.0;

            if (isAlreadyMastered && !isForceRebrush) {
                // ───────────── 分支 1：跳过已满分知识点 ─────────────
                skippedCount++;
                console.log(`[KG-Auto] ⏭ knowledgeId=${nextKnowledgeId} 已满分 (masteryLevel=${masteryLevel})，跳过！`);
                showPanel('⏭ 已满分，正在跳过…', completedCount, `#${nextKnowledgeId} (已满分)`);
                showToast(
                    `⏭ 已满分，跳过`,
                    `知识点 #${nextKnowledgeId} masteryLevel=${masteryLevel}`,
                    'info', 2500
                );

                // 短暂等待（模拟用户浏览后决定不做测验，直接翻页）
                await sleep(randomInt(500, 1200));

                // ★ 关键：跳过后仍需拉取 quizList 来获取 nextKnowledge 链条
                //   否则递归链条会断裂（我们需要知道 nextKnowledgeId 的下一关是谁）
                checkAbort();
                const skipResult = await fetchQuizList(nextKnowledgeId);
                const afterNextId   = skipResult.nextKnowledge ? skipResult.nextKnowledge.id : null;
                const afterNextName = skipResult.nextKnowledge ? skipResult.nextKnowledge.name : '';

                if (!afterNextId) {
                    // 跳过的是最后一关
                    onAllDone();
                    return;
                }

                // 递归：将 nextKnowledgeId 作为已完成（空题目列表），继续向后
                completedCount++; // 计入已完成（虽然是跳过的）
                checkAbort();
                await autoBrush(nextKnowledgeId, [], afterNextId, afterNextName);
                return;
            }

            // ───────────── 分支 2：正常答题流程 ─────────────
            if (isAlreadyMastered && isForceRebrush) {
                console.log(`[KG-Auto] 🔄 knowledgeId=${nextKnowledgeId} 已满分但强制重刷开关已开启`);
            }

            // ── 步骤 F：幽灵请求 Phase 2 → 加载资源列表 ─────
            await ghostFetchResources(nextKnowledgeId);

            // ── 步骤 G：拉取下一关题目 ────────────────────────
            checkAbort();
            console.log(`[KG-Auto] ⏭ 拉取下一关 quizList → knowledgeId=${nextKnowledgeId}`);
            showPanel('📡 加载下一关…', completedCount);

            const nextResult = await fetchQuizList(nextKnowledgeId);
            const nextQuestions = nextResult.list || [];
            const afterNextId   = nextResult.nextKnowledge ? nextResult.nextKnowledge.id : null;
            const afterNextName = nextResult.nextKnowledge ? nextResult.nextKnowledge.name : '';

            // ── 步骤 H：递归到下一关 ─────────────────────────
            checkAbort();
            await autoBrush(
                nextKnowledgeId,
                nextQuestions,
                afterNextId,
                afterNextName
            );

        } catch (err) {
            if (err instanceof AbortError) {
                // ★ 用户主动终止 —— 安全退出，不报错
                console.log(`[KG-Auto] 🛑 调度器已安全终止（在 knowledgeId=${knowledgeId} 处）`);
                showPanel('🛑 已安全终止', completedCount, knowledgeName);
                showToast('🛑 已安全终止', `共完成 ${completedCount} 个，跳过 ${skippedCount} 个`, 'warning', 6000);
                return;
            }
            // 真实错误
            console.error(`[KG-Auto] ❌ 处理 knowledgeId=${knowledgeId} 时出错:`, err);
            showToast('刷题过程出现错误', err.message, 'error', 8000);
            showPanel('❌ 已暂停（出错）', completedCount, knowledgeName);
        }
    }

    function onAllDone() {
        schedulerRunning = false;
        hidePanel();
        console.log(`[KG-Auto] 🎉 全部完成！共刷完 ${completedCount} 个知识点（跳过 ${skippedCount} 个已满分），3秒后刷新页面`);

        // 大型完成提示
        injectStyles();
        const mask = document.createElement('div');
        mask.style.cssText = `
            position:fixed; inset:0; z-index:2147483647;
            background:rgba(10,10,25,0.78); backdrop-filter:blur(6px);
            display:flex; align-items:center; justify-content:center;
            font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
            animation: kg-in 0.4s ease forwards;
        `;
        mask.innerHTML = `
            <div style="
                background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15);
                border-radius:24px; padding:48px 56px; text-align:center;
                box-shadow:0 24px 60px rgba(0,0,0,0.4); color:#fff; max-width:440px;
            ">
                <div style="font-size:64px; margin-bottom:16px;">🎉</div>
                <div style="font-size:26px; font-weight:700; margin-bottom:10px;
                    background:linear-gradient(90deg,#a78bfa,#60a5fa,#34d399);
                    -webkit-background-clip:text; -webkit-text-fill-color:transparent;">
                    全图谱满分刷题完成！
                </div>
                <div style="font-size:15px; opacity:0.75; margin-bottom:28px; line-height:1.7;">
                    共完成 <strong style="-webkit-text-fill-color:#7dd3fc">${completedCount}</strong> 个知识点的测验
                    ${skippedCount > 0 ? `<br>其中 <strong style="-webkit-text-fill-color:#a78bfa">${skippedCount}</strong> 个已满分自动跳过` : ''}<br>
                    页面将在 <strong style="-webkit-text-fill-color:#34d399" id="kg-final-countdown">3</strong> 秒后自动刷新…
                </div>
                <div style="font-size:12px; opacity:0.45;">刷新后所有知识点将显示满分绿灯状态</div>
            </div>
        `;
        document.body.appendChild(mask);

        let t = 3;
        const timer = setInterval(() => {
            t--;
            const el = document.getElementById('kg-final-countdown');
            if (el) el.textContent = t;
            if (t <= 0) {
                clearInterval(timer);
                window.location.reload();
            }
        }, 1000);
    }


    // ============================================================
    //  Hook 引擎：劫持 fetch 以监听第一次 quizList 请求
    // ============================================================

    window.fetch = async function (...args) {
        const input = args[0];
        const init  = args[1] || {};
        const url   = (input instanceof Request) ? input.url : String(input);

        // ① 捕获 Authorization Token
        if (!capturedToken && url.includes('knowledgeapi.ulearning.cn')) {
            const rawHeaders = (input instanceof Request)
                ? Object.fromEntries([...input.headers.entries()])
                : (init.headers || {});
            const token =
                (rawHeaders instanceof Headers ? rawHeaders.get('Authorization') : null) ||
                rawHeaders['Authorization'] || rawHeaders['authorization'];
            if (token) {
                capturedToken = token;
                console.log('[KG-Auto] ✅ 已捕获 Token:', token.substring(0, 8) + '…');
            }
        }

        // 发起原始请求（使用闭包顶部保存的原生 fetch）
        const response = await originalFetch.apply(this, args);

        // ② 监听 quizList 响应 → 作为引擎点火信号
        if (url.includes('/questionRelation/quizList') && !schedulerRunning) {
            schedulerRunning = true;
            isAborted = false; // 重置停止标志
            completedCount = 0; // 重置计数
            skippedCount = 0;   // ★ [v3.1] 重置跳过计数
            const cloned = response.clone();

            cloned.json().then(data => {
                if (data.code !== 1 || !data.result || !data.result.list) return;

                const urlObj      = new URL(url);
                const knowledgeId = parseInt(urlObj.searchParams.get('knowledgeId'), 10);
                const questionList   = data.result.list;
                const nextKnowledge  = data.result.nextKnowledge;
                const nextId         = nextKnowledge ? nextKnowledge.id : null;
                const nextName       = nextKnowledge ? nextKnowledge.name : '';

                console.log(`[KG-Auto] 🚀 引擎点火！起始 knowledgeId=${knowledgeId}，题目 ${questionList.length} 道，下一关 ID=${nextId}`);
                showToast(
                    '🚀 全自动刷题调度器已启动',
                    `正在后台静默刷完所有知识点，请勿关闭页面`,
                    'info', 6000
                );

                // 启动调度器（不 await，让它在后台跑）
                autoBrush(knowledgeId, questionList, nextId, nextName);

            }).catch(e => console.error('[KG-Auto] 解析 quizList 响应失败:', e));
        }

        return response;
    };

    // ============================================================
    //  XHR 兜底 Hook
    // ============================================================
    const OrigXHR = window.XMLHttpRequest;
    function HookedXHR() {
        const xhr = new OrigXHR();
        let _url = '';
        const origOpen = xhr.open.bind(xhr);
        const origSetHeader = xhr.setRequestHeader.bind(xhr);

        xhr.open = function (method, url, ...rest) {
            _url = url;
            return origOpen(method, url, ...rest);
        };
        xhr.setRequestHeader = function (name, value) {
            if (!capturedToken && name.toLowerCase() === 'authorization' && _url.includes('knowledgeapi.ulearning.cn')) {
                capturedToken = value;
                console.log('[KG-Auto] ✅ (XHR) 已捕获 Token:', value.substring(0, 8) + '…');
            }
            return origSetHeader(name, value);
        };
        xhr.addEventListener('load', function () {
            if (_url.includes('/questionRelation/quizList') && !schedulerRunning) {
                schedulerRunning = true;
                isAborted = false;
                completedCount = 0;
                skippedCount = 0;
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data.code !== 1 || !data.result || !data.result.list) return;
                    const urlObj      = new URL(_url, location.origin);
                    const knowledgeId = parseInt(urlObj.searchParams.get('knowledgeId'), 10);
                    const questionList   = data.result.list;
                    const nextKnowledge  = data.result.nextKnowledge;
                    autoBrush(knowledgeId, questionList, nextKnowledge ? nextKnowledge.id : null, nextKnowledge ? nextKnowledge.name : '');
                } catch(e) { console.error('[KG-Auto] XHR 解析失败:', e); }
            }
        });
        return xhr;
    }
    HookedXHR.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = HookedXHR;

    // ============================================================
    //  页面就绪后注入面板样式 & 提示
    // ============================================================
    const readyFn = () => {
        injectStyles();
        setTimeout(() => {
            showToast(
                '⚡ 全自动刷题脚本已就绪 (v3.1 幂等防风控版)',
                '请点击任意知识点的「去测验」以启动引擎，已满分测验将自动跳过',
                'info', 7000
            );
        }, 1000);
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', readyFn);
    } else {
        readyFn();
    }

    console.log('[KG-Auto v3.1] Fetch & XHR Hook 注入完成，等待用户点击「去测验」以点火…');
    console.log('[KG-Auto v3.1] 防风控增强: 幽灵请求链 ✓ | 动态字数耗时 ✓ | 紧急停止 ✓ | 幂等跳过 ✓');

})();
