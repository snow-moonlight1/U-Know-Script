// ==UserScript==
// @name         U-Know 优学院知识图谱
// @namespace    kg.ulearning.auto.v3
// @version      3.2.0
// @description  自动化知识图谱测验辅助工具
// @icon         https://www.ulearning.cn/ulearning/favicon.ico
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
    let capturedToken = null;   // 窃取到的 Authorization Token
    let schedulerRunning = false;  // 调度器是否正在运行（防止重复点火）
    let completedCount = 0;     // 已完成的知识点数量
    let skippedCount = 0;     // ★ [v3.1] 跳过的已满分知识点数量

    // ★ [新增] 紧急停止标志位 —— Kill Switch
    let isAborted = false;
    let isPaused = false;
    let pauseResolver = null;

    // ★ [v3.1] 强制重刷开关状态（跨 DOM 重建持久化）
    let forceRebrush = localStorage.getItem('uknow_force_rebrush') === 'true';
    let settingsOpen = false;

    const ICONS = {
        settings: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
        info: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
        circleCheck: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
        circleX: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-x"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
        triangleAlert: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
        square: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>',
        sun: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
        moon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
        monitor: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-monitor"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>',
        play: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
        pause: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pause"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>'
    };

    function getSetting(key, def) {
        const val = localStorage.getItem(key);
        if (val === null) return def;
        const parsed = parseFloat(val);
        return isNaN(parsed) ? def : parsed;
    }

    function applyTheme(theme) {
        let isDark = false;
        if (theme === 'dark') isDark = true;
        else if (theme === 'auto' || !theme) isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

        let styleEl = document.getElementById('uknow-theme-vars');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'uknow-theme-vars';
            document.head.appendChild(styleEl);
        }

        styleEl.textContent = `
            :root {
                --uk-bg: ${isDark ? 'rgba(30, 41, 59, 0.85)' : 'rgba(255, 255, 255, 0.85)'};
                --uk-bg-secondary: ${isDark ? 'rgba(15, 23, 42, 0.5)' : 'rgba(241, 245, 249, 0.7)'};
                --uk-border: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)'};
                --uk-text: ${isDark ? '#f8fafc' : '#0f172a'};
                --uk-text-secondary: ${isDark ? '#94a3b8' : '#64748b'};
                --uk-primary: ${isDark ? '#60a5fa' : '#3b82f6'};
                --uk-shadow: ${isDark ? '0 10px 25px -5px rgba(0,0,0,0.5)' : '0 10px 30px -5px rgba(0,0,0,0.1)'};
                --uk-hover: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'};
                --uk-active: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};
                --uk-progress-bg: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)'};
            }
        `;
    }

    let currentTheme = localStorage.getItem('uknow_theme') || 'auto';
    applyTheme(currentTheme);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (localStorage.getItem('uknow_theme') === 'auto' || !localStorage.getItem('uknow_theme')) {
            applyTheme('auto');
        }
    });

    function setTheme(theme) {
        currentTheme = theme;
        localStorage.setItem('uknow_theme', theme);
        applyTheme(theme);
    }

    function sleep(ms) {
        return new Promise((resolve, reject) => {
            let elapsed = 0;
            let lastTick = Date.now();

            const check = () => {
                if (isAborted) {
                    reject(new AbortError('用户已按下紧急停止'));
                    return;
                }
                const now = Date.now();

                if (isPaused) {
                    lastTick = now;
                    setTimeout(check, 500);
                    return;
                }

                elapsed += (now - lastTick);
                lastTick = now;

                if (elapsed >= ms) {
                    resolve();
                } else {
                    setTimeout(check, Math.min(500, ms - elapsed));
                }
            };
            check();
        });
    }

    class AbortError extends Error {
        constructor(msg) {
            super(msg);
            this.name = 'AbortError';
        }
    }

    function checkAbort() {
        if (isAborted) throw new AbortError('用户已按下紧急停止');
    }

    async function waitIfPaused() {
        if (isPaused) {
            console.log('[U-Know] 脚本已暂停等待中...');
            await new Promise(resolve => {
                pauseResolver = resolve;
            });
            console.log('[U-Know] 脚本已恢复运行');
        }
    }

    function randomGaussian(min, max) {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        const stdNormal = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        const mean = (min + max) / 2;
        const stdDev = (max - min) / 6;
        const result = mean + stdDev * stdNormal;
        return Math.max(min, Math.min(max, result));
    }

    function randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function extractTotalCharCount(questionList) {
        let totalText = '';
        for (const q of questionList) {
            const raw = q.title || q.name || '';
            const cleaned = raw.replace(/<[^>]*>/g, '').trim();
            totalText += cleaned;
            if (Array.isArray(q.item)) {
                for (const opt of q.item) {
                    totalText += (opt.title || '').replace(/<[^>]*>/g, '').trim();
                }
            }
        }
        if (totalText.length === 0) {
            return questionList.length * 50;
        }
        return totalText.length;
    }

    function calculateAnswerDelay(questionList) {
        let baseTime = getSetting('uknow_baseTime', 8);
        let tMin = getSetting('uknow_thinkMin', 2);
        let tMax = getSetting('uknow_thinkMax', 5);

        // 容错处理：如果用户填反了大小值，自动交换
        if (tMin > tMax) {
            let temp = tMin;
            tMin = tMax;
            tMax = temp;
        }

        let totalTime = 0;
        for (let i = 0; i < questionList.length; i++) {
            // 单题总耗时 = 基础耗时 + 随机延时波动
            totalTime += baseTime + randomGaussian(tMin, tMax);
        }

        // 完全移除所有“模拟阅读时长”，一切以面板数值为准，所见即所得
        return Math.max(1, Math.round(totalTime));
    }

    function injectStyles() {
        if (document.getElementById('kg-auto-style')) return;
        const style = document.createElement('style');
        style.id = 'kg-auto-style';
        style.textContent = `
            #kg-toast-wrap {
                position: fixed; top: 20px; right: 20px; z-index: 2147483647;
                display: flex; flex-direction: column; gap: 10px; pointer-events: none;
                font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            }
            .kg-toast {
                padding: 13px 18px; border-radius: 12px; pointer-events: all;
                font-size: 13.5px; font-weight: 500; min-width: 280px; max-width: 360px;
                background: var(--uk-bg); color: var(--uk-text);
                border: 1px solid var(--uk-border);
                box-shadow: var(--uk-shadow);
                backdrop-filter: blur(16px) saturate(120%);
                -webkit-backdrop-filter: blur(16px) saturate(120%);
                line-height: 1.5; display: flex; align-items: flex-start; gap: 10px;
                animation: kg-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            }
            .kg-toast.out { animation: kg-out 0.3s ease forwards; }
            .kg-toast .kg-icon { width: 20px; height: 20px; flex-shrink: 0; margin-top: 1px; color: var(--toast-color); }
            .kg-toast .kg-icon svg { width: 100%; height: 100%; }
            .kg-toast .kg-body { flex: 1; text-wrap: pretty; }
            .kg-toast .kg-title { font-weight: 700; margin-bottom: 2px; }
            .kg-toast .kg-sub   { color: var(--uk-text-secondary); font-size: 12.5px; text-wrap: pretty; }
            .kg-toast.info    { --toast-color: var(--uk-text-secondary); }
            .kg-toast.info .kg-icon { display: none; }
            .kg-toast.success { --toast-color: #10b981; }
            .kg-toast.error   { --toast-color: #ef4444; }
            .kg-toast.warning { --toast-color: #f59e0b; }

            #kg-panel {
                position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
                background: var(--uk-bg); border: 1px solid var(--uk-border);
                border-radius: 16px; padding: 18px 20px; color: var(--uk-text);
                min-width: 280px; width: 320px; box-sizing: border-box;
                font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                font-size: 13px; box-shadow: var(--uk-shadow);
                backdrop-filter: blur(16px) saturate(120%);
                -webkit-backdrop-filter: blur(16px) saturate(120%);
                animation: kg-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            }
            #kg-panel * { box-sizing: border-box; }
            .kg-panel-title {
                font-size: 15px; font-weight: 700; color: var(--uk-text);
                display: flex; align-items: center; text-wrap: balance;
            }
            .kg-settings-btn {
                cursor: pointer; padding: 4px; border-radius: 6px;
                color: var(--uk-text-secondary); background: transparent; transition: all 0.2s;
                display: flex; align-items: center; justify-content: center;
            }
            .kg-settings-btn:hover { background: var(--uk-hover); color: var(--uk-text); }
            
            #kg-settings-panel {
                background: var(--uk-bg-secondary); border-radius: 10px;
                padding: 14px; margin-bottom: 12px;
                border: 1px solid var(--uk-border);
            }
            .kg-settings-row {
                display: flex; justify-content: space-between; align-items: center;
                margin-bottom: 12px; color: var(--uk-text-secondary);
            }
            .kg-settings-row:last-child { margin-bottom: 0; }
            .kg-theme-group { display: flex; gap: 4px; background: var(--uk-bg); padding: 3px; border-radius: 8px; border: 1px solid var(--uk-border); }
            .kg-theme-btn {
                background: transparent; border: none; padding: 4px 8px; border-radius: 6px; cursor: pointer;
                color: var(--uk-text-secondary); display: flex; align-items: center; transition: all 0.2s;
            }
            .kg-theme-btn:hover { color: var(--uk-text); }
            .kg-theme-btn.active { background: var(--uk-primary); color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
            .kg-input {
                background: var(--uk-bg); border: 1px solid var(--uk-border); border-radius: 6px;
                color: var(--uk-text); padding: 4px 8px; font-family: inherit; font-size: 12px;
                text-align: center; outline: none; -moz-appearance: textfield; transition: border-color 0.2s;
            }
            .kg-input::-webkit-outer-spin-button, .kg-input::-webkit-inner-spin-button {
                -webkit-appearance: none; margin: 0;
            }
            .kg-input:focus { border-color: var(--uk-primary); }

            #kg-panel .kg-row { display: flex; justify-content: space-between; margin: 8px 0; color: var(--uk-text-secondary); }
            #kg-panel .kg-val { font-weight: 600; color: var(--uk-text); text-align: right; text-wrap: balance; }
            
            #kg-progress-bar-wrap {
                background: var(--uk-progress-bg); border-radius: 99px;
                height: 6px; margin-top: 12px; margin-bottom: 12px; overflow: hidden;
                width: 100%; display: none;
            }
            #kg-progress-bar-inner {
                height: 100%; border-radius: 99px; background: var(--uk-primary);
                width: 0%; transition: width 1s linear;
            }

            .kg-btn-secondary, .kg-btn-danger {
                display: flex; align-items: center; justify-content: center; gap: 6px;
                width: 100%; padding: 10px; border: none; border-radius: 8px; cursor: pointer;
                font-size: 13px; font-weight: 500; font-family: inherit; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            }
            .kg-btn-secondary {
                background: var(--uk-bg-secondary); color: var(--uk-text);
                border: 1px solid var(--uk-border);
            }
            .kg-btn-secondary:hover { background: var(--uk-hover); border-color: var(--uk-text-secondary); }
            .kg-btn-secondary:active { transform: scale(0.97); }
            .kg-btn-secondary.active {
                background: var(--uk-primary); color: #fff; border-color: var(--uk-primary);
            }
            
            .kg-btn-danger {
                background: var(--uk-bg-secondary); color: #ef4444; border: 1px solid var(--uk-border);
            }
            .kg-btn-danger:hover { background: #ef4444; color: #fff; border-color: #ef4444; }
            .kg-btn-danger:active { transform: scale(0.97); border-color: #dc2626; background: #dc2626; color: #fff; }
            .kg-btn-danger:disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; transform: none; }

            .kg-skip-val { color: var(--uk-primary) !important; }

            /* 倒计时文字颜色 */
            #kg-countdown-row .kg-val { color: #f59e0b !important; font-variant-numeric: tabular-nums; }
            .kg-pulsing { animation: kg-pulse 1.5s ease-in-out infinite; }
            
            /* Switch 开关组件 (性能优化版) */
            .kg-switch { display: inline-block; position: relative; width: 44px; height: 24px; vertical-align: middle; }
            .kg-switch input { opacity: 0; width: 0; height: 0; }
            .kg-switch-slider {
                position: absolute; top: 0; left: 0; right: 0; bottom: 0; cursor: pointer;
                background-color: var(--uk-bg-secondary); border: 1px solid var(--uk-border);
                border-radius: 24px; transition: background-color 0.2s ease, border-color 0.2s ease;
            }
            .kg-switch-slider:before {
                position: absolute; content: ""; height: 18px; width: 18px; left: 2px; bottom: 2px;
                background-color: var(--uk-text-secondary); border-radius: 50%;
                transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.2s ease;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                /* 启用 GPU 加速 */
                transform: translate3d(0, 0, 0);
                will-change: transform;
            }
            .kg-switch input:checked + .kg-switch-slider {
                background-color: var(--uk-primary); border-color: var(--uk-primary);
            }
            .kg-switch input:checked + .kg-switch-slider:before {
                transform: translate3d(20px, 0, 0); background-color: #ffffff;
            }
            
            @keyframes kg-in  { from { transform: translateX(60px) scale(0.92); opacity:0; } to { transform: none; opacity:1; } }
            @keyframes kg-out { from { transform: none; opacity:1; } to { transform: translateX(60px) scale(0.92); opacity:0; } }
            @keyframes kg-pulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }
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
        const mapping = { info: ICONS.info, success: ICONS.circleCheck, error: ICONS.circleX, warning: ICONS.triangleAlert };
        const iconSvg = mapping[type] || ICONS.info;
        const el = document.createElement('div');
        el.className = `kg-toast ${type}`;
        el.innerHTML = `
            <span class="kg-icon">${iconSvg}</span>
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

    let panelEl = null;

    function showPanel(statusText, count, knowledgeName = '', countdown = 0, pulsing = false) {
        injectStyles();
        if (!panelEl) {
            panelEl = document.createElement('div');
            panelEl.id = 'kg-panel';
            document.body.appendChild(panelEl);
        }

        const countdownRow = countdown > 0
            ? `<div class="kg-row ${pulsing ? 'kg-pulsing' : ''}" id="kg-countdown-row">
                   <span>模拟答题倒计时</span>
                   <span class="kg-val">剩余 ${countdown}s</span>
               </div>`
            : '';

        const abortedLabel = isAborted
            ? `<div class="kg-row" style="color:#ef4444;font-weight:700;"><span>已中止</span></div>`
            : '';

        const skipRow = skippedCount > 0
            ? `<div class="kg-row"><span>已跳过</span><span class="kg-val kg-skip-val">${skippedCount} 项测验</span></div>`
            : '';

        panelEl.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                <div class="kg-panel-title">U-Know 优学院知识图谱</div>
                <div class="kg-settings-btn" id="kg-btn-settings" title="设置">${ICONS.settings}</div>
            </div>

            <div id="kg-settings-panel" style="display: ${settingsOpen ? 'block' : 'none'};">
                <div class="kg-settings-row">
                    <span>主题模式</span>
                    <div class="kg-theme-group">
                        <button class="kg-theme-btn ${currentTheme === 'light' ? 'active' : ''}" data-theme="light" title="浅色">${ICONS.sun}</button>
                        <button class="kg-theme-btn ${currentTheme === 'auto' ? 'active' : ''}" data-theme="auto" title="跟随系统">${ICONS.monitor}</button>
                        <button class="kg-theme-btn ${currentTheme === 'dark' ? 'active' : ''}" data-theme="dark" title="深色">${ICONS.moon}</button>
                    </div>
                </div>
                <div class="kg-settings-row">
                    <span>单题基础耗时 (秒)</span>
                    <input type="number" min="0" step="1" id="kg-set-base" class="kg-input" value="${getSetting('uknow_baseTime', 8)}" style="width: 50px;" />
                </div>
                <div class="kg-settings-row">
                    <span>单题随机延时 (秒)</span>
                    <div style="display:flex; gap: 6px; align-items:center;">
                        <input type="number" min="0" step="1" id="kg-set-t1" class="kg-input" style="width: 44px;" value="${getSetting('uknow_thinkMin', 2)}" />
                        <span>-</span>
                        <input type="number" min="0" step="1" id="kg-set-t2" class="kg-input" style="width: 44px;" value="${getSetting('uknow_thinkMax', 5)}" />
                    </div>
                </div>
                <div class="kg-settings-row" style="margin-top: 4px;">
                    <span title="刷新页面时是否显示加载成功的全息提示">启动提示</span>
                    <label class="kg-switch">
                        <input type="checkbox" id="kg-set-toast" ${getSetting('uknow_toast_startup', 1) === 1 ? 'checked' : ''}>
                        <span class="kg-switch-slider"></span>
                    </label>
                </div>
            </div>

            <div class="kg-row ${pulsing && countdown <= 0 ? 'kg-pulsing' : ''}">
                <span>当前状态</span><span class="kg-val">${statusText}</span>
            </div>
            <div class="kg-row"><span>已完成知识点</span><span class="kg-val">${count} 个</span></div>
            ${skipRow}
            ${knowledgeName ? `<div class="kg-row" style="align-items:flex-start; min-height: 34px;"><span>正在处理</span><span class="kg-val" style="max-width:170px; word-break:break-all; text-align:right; font-size:12px; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;" title="${knowledgeName}">${knowledgeName}</span></div>` : ''}
            ${countdownRow}
            ${abortedLabel}
            
            <div id="kg-progress-bar-wrap" style="display: ${countdown > 0 ? 'block' : 'none'}">
                <div id="kg-progress-bar-inner"></div>
            </div>
            
            <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 8px;">
                <button id="kg-force-rebrush" class="kg-btn-secondary ${forceRebrush ? 'active' : ''}">
                    ${forceRebrush ? '已激活强制重刷' : '强制重刷已满分测验'}
                </button>
                <div style="display: flex; gap: 8px;">
                    <button id="kg-pause-switch" class="kg-btn-secondary" style="flex: 1; ${isPaused ? 'background: #f59e0b; border-color: #f59e0b; color: white;' : ''}" ${!schedulerRunning || isAborted ? 'disabled' : ''}>
                        ${isPaused ? ICONS.play + ' 继续运行' : ICONS.pause + ' 暂停运行'}
                    </button>
                    <button id="kg-kill-switch" class="kg-btn-danger" style="flex: 1;" ${isAborted || !schedulerRunning ? 'disabled' : ''}>
                        ${isAborted ? '已中止' : '停止运行'}
                    </button>
                </div>
            </div>
        `;

        // Event Listeners
        document.getElementById('kg-btn-settings').addEventListener('click', () => {
            settingsOpen = !settingsOpen;
            document.getElementById('kg-settings-panel').style.display = settingsOpen ? 'block' : 'none';
        });

        document.querySelectorAll('.kg-theme-btn').forEach(b => {
            b.addEventListener('click', (e) => {
                const theme = e.currentTarget.dataset.theme;
                setTheme(theme);
                document.querySelectorAll('.kg-theme-btn').forEach(btn => btn.classList.remove('active'));
                e.currentTarget.classList.add('active');
            });
        });

        const syncSettings = () => {
            let tMin = parseFloat(document.getElementById('kg-set-t1').value) || 0;
            let tMax = parseFloat(document.getElementById('kg-set-t2').value) || 0;
            let base = parseFloat(document.getElementById('kg-set-base').value) || 0;
            let toastOn = document.getElementById('kg-set-toast').checked ? 1 : 0;

            // 自动交换反向的值并在 UI 上纠正显示
            if (tMin > tMax) {
                const temp = tMin;
                tMin = tMax;
                tMax = temp;
                document.getElementById('kg-set-t1').value = tMin;
                document.getElementById('kg-set-t2').value = tMax;
            }

            localStorage.setItem('uknow_baseTime', base);
            localStorage.setItem('uknow_thinkMin', tMin);
            localStorage.setItem('uknow_thinkMax', tMax);
            localStorage.setItem('uknow_toast_startup', toastOn);
            console.log('[U-Know] 设置已更新');
            showToast('已保存', '最新设置已生效', 'success', 2500);
        };
        ['kg-set-base', 'kg-set-t1', 'kg-set-t2', 'kg-set-toast'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', syncSettings);
        });

        const fbtn = document.getElementById('kg-force-rebrush');
        if (fbtn) {
            fbtn.addEventListener('click', () => {
                forceRebrush = !forceRebrush;
                localStorage.setItem('uknow_force_rebrush', forceRebrush);
                if (forceRebrush) {
                    fbtn.classList.add('active');
                    fbtn.textContent = '已激活强制重刷';
                } else {
                    fbtn.classList.remove('active');
                    fbtn.textContent = '强制重刷已满分测验';
                }
                console.log(`[U-Know] 强制重刷开关: ${forceRebrush ? '开启' : '关闭'}`);
            });
        }

        const pBtn = document.getElementById('kg-pause-switch');
        if (pBtn && !isAborted && schedulerRunning) {
            pBtn.addEventListener('click', () => {
                isPaused = !isPaused;
                if (!isPaused && pauseResolver) {
                    pauseResolver();
                    pauseResolver = null;
                }

                if (isPaused) {
                    pBtn.innerHTML = ICONS.play + ' 继续运行';
                    pBtn.style.background = '#f59e0b';
                    pBtn.style.borderColor = '#f59e0b';
                    pBtn.style.color = 'white';
                    showToast('已暂停', '点击继续运行恢复进度', 'info', 3000);
                } else {
                    pBtn.innerHTML = ICONS.pause + ' 暂停运行';
                    pBtn.style.background = '';
                    pBtn.style.borderColor = '';
                    pBtn.style.color = '';
                    showToast('已继续', '进度已恢复', 'success', 3000);
                }
            });
        }

        const btn = document.getElementById('kg-kill-switch');
        if (btn && !isAborted) {
            btn.addEventListener('click', () => {
                isAborted = true;
                if (pauseResolver) {
                    pauseResolver();
                    pauseResolver = null;
                }
                btn.disabled = true;
                btn.innerHTML = `正在停止…`;
                showToast('<span style="color:#ef4444">已要求停止</span>', '<span style="color:#ef4444">处理完当前操作后将退出</span>', 'info', 5000);
                console.log('[U-Know] 用户触发停止');
            });
        }
    }

    function updateCountdown(seconds, total) {
        const row = document.getElementById('kg-countdown-row');
        if (row) {
            const valSpan = row.querySelector('.kg-val');
            if (valSpan) valSpan.textContent = `剩余 ${seconds}s`;
        }
        const pbar = document.getElementById('kg-progress-bar-inner');
        if (pbar && total > 0) {
            const pct = Math.min(((total - seconds) / total) * 100, 100);
            pbar.style.width = pct + '%';
        }
    }

    function hidePanel() {
        if (panelEl) { panelEl.remove(); panelEl = null; }
    }

    function apiFetch(url, options = {}) {
        checkAbort();
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

    async function ghostFetchInfo(knowledgeId) {
        console.log(`[U-Know] Phase 1: studentKnowledgeInfo → knowledgeId=${knowledgeId}`);
        checkAbort();
        showPanel('检查状态', completedCount, `知识点 #${knowledgeId}`, 0, true);

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

        console.log(`[U-Know] studentKnowledgeInfo → masteryLevel=${masteryLevel} (${knowledgeName})`);

        const delay1 = randomInt(800, 1500);
        console.log(`[U-Know] 等待 ${delay1}ms`);
        await sleep(delay1);

        return { masteryLevel, knowledgeName };
    }

    async function ghostFetchResources(knowledgeId) {
        console.log(`[U-Know] Phase 2: listByKnowledgeId → knowledgeId=${knowledgeId}`);
        checkAbort();
        showPanel('加载中', completedCount, `资源列表 #${knowledgeId}`, 0, true);

        const listRes = await apiFetch(
            `https://knowledgeapi.ulearning.cn/resourceRelation/listByKnowledgeId?knowledgeId=${knowledgeId}&pn=1&ps=9999`
        );
        const listData = await listRes.json();
        console.log(`[U-Know] listByKnowledgeId → ${listData.list ? listData.list.length : 0} 项资源`);

        const delay2 = randomInt(1500, 3000);
        console.log(`[U-Know] 等待 ${delay2}ms`);
        await sleep(delay2);

        console.log(`[U-Know] Phase 2 完成`);
    }

    async function fetchQuizList(knowledgeId) {
        checkAbort();
        const res = await apiFetch(
            `https://knowledgeapi.ulearning.cn/questionRelation/quizList?knowledgeId=${knowledgeId}`
        );
        const data = await res.json();
        if (data.code !== 1) throw new Error(`quizList 异常: ${data.message}`);
        return data.result;
    }

    async function submitFullScore(knowledgeId, questionList) {
        checkAbort();
        const payload = {
            knowledgeId: knowledgeId,
            answerResultsModels: questionList.map(q => ({
                questionId: q.questionid,
                results: 1
            }))
        };
        const res = await apiFetch('https://knowledgeapi.ulearning.cn/questionRelation/quizResults', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.code !== 1) throw new Error(`quizResults 异常: ${data.message}`);
        return data.result;
    }

    async function simulateAnsweringDelay(questionList, knowledgeName) {
        if (questionList.length === 0) return;

        const totalDelaySec = calculateAnswerDelay(questionList);
        console.log(`[U-Know] 模拟延时 ${totalDelaySec}s (${questionList.length} 题)`);

        showPanel('处理中', completedCount, knowledgeName, totalDelaySec, true);

        for (let remaining = totalDelaySec; remaining > 0; remaining--) {
            checkAbort();
            await waitIfPaused();
            updateCountdown(remaining, totalDelaySec);
            await sleep(1000);
        }

        const pbar = document.getElementById('kg-progress-bar-inner');
        if (pbar) pbar.style.width = '100%';

        console.log(`[U-Know] 延时完成`);
    }

    async function autoBrush(knowledgeId, prefetchedList = null, prefetchedNextId = null) {
        try {
            checkAbort();
            const { masteryLevel, knowledgeName } = await ghostFetchInfo(knowledgeId);
            const isAlreadyMastered = masteryLevel >= 1.0;

            let afterNextId = null;
            let questionList = [];

            if (isAlreadyMastered && !forceRebrush) {
                skippedCount++;
                console.log(`[U-Know] knowledgeId=${knowledgeId} 已满分，跳过`);

                showPanel('<span style="color:#10b981">跳过（已满分）</span>', completedCount, knowledgeName || `#${knowledgeId}`);
                showToast(`已跳过当前测验`, `${knowledgeName || `知识点 #${knowledgeId}`} 已满分`, 'info', 2500);

                await sleep(randomInt(500, 1200));

                if (prefetchedNextId) {
                    afterNextId = prefetchedNextId;
                } else {
                    const skipResult = await fetchQuizList(knowledgeId);
                    afterNextId = skipResult.nextKnowledge ? skipResult.nextKnowledge.id : null;
                }

                if (!afterNextId) {
                    onAllDone();
                    return;
                }

                checkAbort();
                await autoBrush(afterNextId, null, null);
                return;
            }

            // --- 必须进行测试（未满分 或 开启了强制重刷） ---
            await ghostFetchResources(knowledgeId);

            if (prefetchedList) {
                questionList = prefetchedList;
                afterNextId = prefetchedNextId;
            } else {
                showPanel('加载试题', completedCount, knowledgeName);
                const res = await fetchQuizList(knowledgeId);
                questionList = res.list || [];
                afterNextId = res.nextKnowledge ? res.nextKnowledge.id : null;
            }

            if (questionList.length > 0) {
                await simulateAnsweringDelay(questionList, knowledgeName);

                checkAbort();
                await waitIfPaused();
                console.log(`[U-Know] 提交 knowledgeId=${knowledgeId}`);
                showPanel('正在提交', completedCount, knowledgeName);

                const scoreRate = await submitFullScore(knowledgeId, questionList);
                completedCount++;
                const scorePercent = (scoreRate * 100).toFixed(0);

                console.log(`[U-Know] knowledgeId=${knowledgeId} 完成, ${scorePercent}%`);
                showToast(
                    `${knowledgeName || `知识点 #${knowledgeId}`}`,
                    `得分率 ${scorePercent}% | 已完成 ${completedCount} 项`,
                    scoreRate >= 1 ? 'success' : 'warning',
                    3000
                );
            } else {
                console.log(`[U-Know] knowledgeId=${knowledgeId} 空题目，跳过提交`);
                completedCount++;
            }

            if (!afterNextId) {
                onAllDone();
                return;
            }

            checkAbort();
            await autoBrush(afterNextId, null, null);

        } catch (err) {
            if (err instanceof AbortError) {
                console.log(`[U-Know] 已中止 (${knowledgeId})`);
                showPanel('<span style="color:#ef4444;font-weight:bold">已中止</span>', completedCount, `任务已停止`);
                showToast('<span style="color:#ef4444">调度已中止</span>', '<span style="color:#ef4444">任务中断</span>', 'info', 6000);
                return;
            }
            console.error(`[U-Know] 出错 ${knowledgeId}:`, err);
            showToast('处理失败', err.message, 'error', 8000);
            showPanel('出错', completedCount, `错误: ${err.message}`);
        }
    }

    function onAllDone() {
        schedulerRunning = false;
        hidePanel();
        console.log(`[U-Know] 任务完成！共处理 ${completedCount} 项 (含跳过 ${skippedCount} 项)`);

        injectStyles();
        const mask = document.createElement('div');
        mask.style.cssText = `
            position:fixed; inset:0; z-index:2147483647;
            background:rgba(0,0,0,0.6); backdrop-filter:blur(8px);
            display:flex; align-items:center; justify-content:center;
            font-family:system-ui,-apple-system,sans-serif;
            animation: kg-in 0.4s ease forwards;
        `;
        mask.innerHTML = `
            <div style="
                background:var(--uk-bg); border:1px solid var(--uk-border);
                border-radius:24px; padding:48px 56px; text-align:center;
                box-shadow:0 24px 60px rgba(0,0,0,0.4); color:var(--uk-text); max-width:440px;
            ">
                <div style="margin-bottom:20px; color:#10b981; display:flex; justify-content:center;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
                </div>
                <div style="font-size:24px; font-weight:700; margin-bottom:12px;">
                    作业已全部完成
                </div>
                <div style="font-size:15px; color:var(--uk-text-secondary); margin-bottom:32px; line-height:1.6;">
                    共完成 <strong>${completedCount}</strong> 个知识点的测验
                    ${skippedCount > 0 ? `<br>其中 <strong>${skippedCount}</strong> 个由于已满分自动跳过` : ''}<br>
                    页面将在 <strong id="kg-final-countdown">3</strong> 秒后自动刷新...
                </div>
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

    window.fetch = async function (...args) {
        const input = args[0];
        const init = args[1] || {};
        const url = (input instanceof Request) ? input.url : String(input);

        if (!capturedToken && url.includes('knowledgeapi.ulearning.cn')) {
            const rawHeaders = (input instanceof Request)
                ? Object.fromEntries([...input.headers.entries()])
                : (init.headers || {});
            const token =
                (rawHeaders instanceof Headers ? rawHeaders.get('Authorization') : null) ||
                rawHeaders['Authorization'] || rawHeaders['authorization'];
            if (token) {
                capturedToken = token;
                console.log('[U-Know] 获取到授权凭证', token.substring(0, 8) + '…');
            }
        }

        const response = await originalFetch.apply(this, args);

        if (url.includes('/questionRelation/quizList') && !schedulerRunning) {
            schedulerRunning = true;
            isAborted = false;
            completedCount = 0;
            skippedCount = 0;
            const cloned = response.clone();

            cloned.json().then(data => {
                if (data.code !== 1 || !data.result || !data.result.list) return;

                const urlObj = new URL(url, location.origin);
                const knowledgeId = parseInt(urlObj.searchParams.get('knowledgeId'), 10);
                const questionList = data.result.list;
                const nextKnowledge = data.result.nextKnowledge;
                const nextId = nextKnowledge ? nextKnowledge.id : null;

                console.log(`[U-Know] 引擎启动 -> id=${knowledgeId}, 共${questionList.length}题, 下一关=${nextId}`);
                showToast(
                    '处理已启动',
                    `脚本已开始运行，支持后台运行，请保持标签页开启`,
                    'info', 6000
                );

                autoBrush(knowledgeId, questionList, nextId);

            }).catch(e => console.error('[U-Know] 拦截分析失败:', e));
        }

        return response;
    };

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
                console.log('[U-Know] 获取到授权凭证 (XHR)', value.substring(0, 8) + '…');
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
                    const urlObj = new URL(_url, location.origin);
                    const knowledgeId = parseInt(urlObj.searchParams.get('knowledgeId'), 10);
                    const questionList = data.result.list;
                    const nextKnowledge = data.result.nextKnowledge;
                    autoBrush(knowledgeId, questionList, nextKnowledge ? nextKnowledge.id : null);
                } catch (e) { console.error('[U-Know] XHR 拦截失败:', e); }
            }
        });
        return xhr;
    }
    HookedXHR.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = HookedXHR;

    const readyFn = () => {
        injectStyles();
        setTimeout(() => {
            if (getSetting('uknow_toast_startup', 1) !== 1) return; // 用户关闭了初始化提示

            const currentUrl = window.location.href;
            if (currentUrl.includes('/coursekg/')) {
                // 图谱可视化界面
                showToast(
                    '图谱界面加载成功',
                    '请点击任意知识点 → 点击右侧的「学习」',
                    'info', 8000
                );
            } else if (currentUrl.includes('/stuLearn/')) {
                // 学习界面
                showToast(
                    '学习界面加载成功',
                    '点击左上角三杠唤出菜单 → 找到最上面的知识点并点击 → 点击「去测验」启动脚本',
                    'info', 7000
                );
            } else {
                // 其他界面
                showToast(
                    '页面加载成功',
                    '请进入知识图谱界面开始使用',
                    'info', 6000
                );
            }
        }, 1000);
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', readyFn);
    } else {
        readyFn();
    }

    console.log('[U-Know] 核心加载完成，模块已就绪');

})();
