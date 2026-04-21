// ==UserScript==
// @name         优学院知识图谱 - 全自动满分刷题调度器
// @namespace    kg.ulearning.auto.v2
// @version      2.0.0
// @description  拦截第一次"去测验"请求作为引擎点火，随后在后台全自动递归刷完整个知识图谱的所有测验，无需手动操作。纯API方案。
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
    let completedCount   = 0;      // 已完成的知识点数量

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
                padding: 16px 20px; color: #fff; min-width: 240px;
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

            @keyframes kg-in  { from { transform: translateX(60px) scale(0.92); opacity:0; } to { transform: none; opacity:1; } }
            @keyframes kg-out { from { transform: none; opacity:1; } to { transform: translateX(60px) scale(0.92); opacity:0; } }
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
    //  UI: 进度面板（右下角常驻）
    // ============================================================
    let panelEl = null;

    function showPanel(title, statusText, count, knowledgeName = '') {
        injectStyles();
        if (!panelEl) {
            panelEl = document.createElement('div');
            panelEl.id = 'kg-panel';
            document.body.appendChild(panelEl);
        }
        panelEl.innerHTML = `
            <div class="kg-panel-title">⚡ 知识图谱全自动刷题</div>
            <div class="kg-row"><span>状态</span><span class="kg-val">${statusText}</span></div>
            <div class="kg-row"><span>已完成</span><span class="kg-val">${count} 个知识点</span></div>
            ${knowledgeName ? `<div class="kg-row"><span>当前</span><span class="kg-val" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${knowledgeName}</span></div>` : ''}
            <div class="kg-progress-bar-wrap">
                <div class="kg-progress-bar" style="width:${Math.min(count * 10, 100)}%"></div>
            </div>
        `;
    }

    function hidePanel() {
        if (panelEl) { panelEl.remove(); panelEl = null; }
    }

    // ============================================================
    //  API 调用封装（使用闭包顶部保存的原生 fetch，永不受 Hook 影响）
    // ============================================================
    function apiFetch(url, options = {}) {
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

    /** 获取某个知识点的测验题目列表 */
    async function fetchQuizList(knowledgeId) {
        const res = await apiFetch(
            `https://knowledgeapi.ulearning.cn/questionRelation/quizList?knowledgeId=${knowledgeId}`
        );
        const data = await res.json();
        if (data.code !== 1) throw new Error(`quizList 接口返回异常: ${data.message}`);
        return data.result; // { list: [...], nextKnowledge: {...} }
    }

    /** 提交满分答案 */
    async function submitFullScore(knowledgeId, questionList) {
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
    //  核心调度器：autoBrush 递归引擎
    // ============================================================
    async function autoBrush(knowledgeId, questionList, nextKnowledgeId, knowledgeName = '') {
        try {
            // ── 步骤 A：满分交卷 ──────────────────────────────
            console.log(`[KG-Auto] ▶ 正在提交 knowledgeId=${knowledgeId}（${questionList.length} 题）`);
            showPanel('🔥 刷题进行中', '提交答案…', completedCount, knowledgeName);

            const scoreRate = await submitFullScore(knowledgeId, questionList);
            completedCount++;
            const scorePercent = (scoreRate * 100).toFixed(0);
            console.log(`[KG-Auto] ✅ knowledgeId=${knowledgeId} 提交完成，得分率 ${scorePercent}%`);

            // ── 步骤 B：判断是否还有下一关 ───────────────────
            if (!nextKnowledgeId) {
                // 没有下一关，所有课程刷完！
                onAllDone();
                return;
            }

            // ── 步骤 C：拉取下一关题目 ────────────────────────
            console.log(`[KG-Auto] ⏭ 拉取下一关 knowledgeId=${nextKnowledgeId}`);
            showPanel('🔥 刷题进行中', '加载下一关…', completedCount);

            // 加一点点延迟，避免服务器限频
            await sleep(300);

            const nextResult = await fetchQuizList(nextKnowledgeId);
            const nextQuestions = nextResult.list;
            const afterNextId   = nextResult.nextKnowledge ? nextResult.nextKnowledge.id : null;
            const afterNextName = nextResult.nextKnowledge ? nextResult.nextKnowledge.name : '';

            if (!nextQuestions || nextQuestions.length === 0) {
                console.warn(`[KG-Auto] knowledgeId=${nextKnowledgeId} 没有题目，跳过`);
                // 继续往下递归（可能是纯视频知识点）
                await autoBrush(nextKnowledgeId, [], afterNextId, afterNextName);
                return;
            }

            // ── 步骤 D：递归 ─────────────────────────────────
            await autoBrush(
                nextKnowledgeId,
                nextQuestions,
                afterNextId,
                nextResult.nextKnowledge ? nextResult.nextKnowledge.name : ''
            );

        } catch (err) {
            console.error(`[KG-Auto] ❌ 处理 knowledgeId=${knowledgeId} 时出错:`, err);
            showToast('刷题过程出现错误', err.message, 'error', 8000);
            showPanel('❌ 已暂停', '发生错误', completedCount);
        }
    }

    function onAllDone() {
        hidePanel();
        console.log(`[KG-Auto] 🎉 全部完成！共刷完 ${completedCount} 个知识点，3秒后刷新页面`);

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
                    共完成 <strong style="-webkit-text-fill-color:#7dd3fc">${completedCount}</strong> 个知识点的测验<br>
                    页面将在 <strong style="-webkit-text-fill-color:#34d399" id="kg-countdown">3</strong> 秒后自动刷新…
                </div>
                <div style="font-size:12px; opacity:0.45;">刷新后所有知识点将显示满分绿灯状态</div>
            </div>
        `;
        document.body.appendChild(mask);

        let t = 3;
        const timer = setInterval(() => {
            t--;
            const el = document.getElementById('kg-countdown');
            if (el) el.textContent = t;
            if (t <= 0) {
                clearInterval(timer);
                window.location.reload();
            }
        }, 1000);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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
                '⚡ 全自动刷题脚本已就绪',
                '请点击任意知识点的「去测验」以启动引擎，脚本将自动完成后续所有测验',
                'info', 7000
            );
        }, 1000);
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', readyFn);
    } else {
        readyFn();
    }

    console.log('[KG-Auto v2.0] Fetch & XHR Hook 注入完成，等待用户点击「去测验」以点火…');

})();
