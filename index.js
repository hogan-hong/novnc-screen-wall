// NoVNC 屏幕墙 - 主进程
// 每个 VNC 设备使用独立的 BrowserView (独立Chromium渲染进程, 内存隔离)
const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// ============================================================
// 配置文件加载
// ============================================================
function loadConfig() {
    // 优先读取 exe 同目录的配置文件 (打包后用户可改)
    const candidates = [
        path.join(path.dirname(app.getPath('exe')), '配置文件.json'),  // 打包后
        path.join(__dirname, '配置文件.json'),                          // 开发时
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            console.log('[Config] 读取:', p);
            return { config: JSON.parse(fs.readFileSync(p, 'utf-8')), path: p };
        }
    }
    throw new Error('配置文件.json 未找到');
}

let CONFIG, CONFIG_PATH;
try {
    const r = loadConfig();
    CONFIG = r.config;
    CONFIG_PATH = r.path;
} catch (e) {
    console.error('[FATAL]', e.message);
    app.quit();
    process.exit(1);
}

// ============================================================
// 启动参数
// ============================================================
const _debugMode = process.argv.includes('--debug');

// 给Chromium加内存限制和性能参数 (每个渲染进程独立生效)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256 --expose-gc');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');  // 防止子view被遮挡时暂停渲染
app.commandLine.appendSwitch('site-per-process');  // 强制每个origin独立进程

// ============================================================
// 主窗口 + BrowserView 网格
// ============================================================
let mainWindow = null;
const views = [];  // { view, device, index, bounds }

function createMainWindow() {
    const w = CONFIG.window;
    mainWindow = new BrowserWindow({
        width: w.width || 1920,
        height: w.height || 1080,
        title: w.title || 'NoVNC 屏幕墙',
        backgroundColor: w.backgroundColor || '#111111',
        fullscreen: !!w.fullscreen,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('overlay.html');

    // 最大化按钮 = 切全屏 (像浏览器F11)
    mainWindow.on('maximize', () => {
        mainWindow.unmaximize();
        mainWindow.setFullScreen(true);
    });

    if (_debugMode) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    mainWindow.on('resize', layoutViews);
    mainWindow.on('closed', () => {
        mainWindow = null;
        app.quit();
    });

    mainWindow.webContents.once('did-finish-load', () => {
        createAllViews();
        layoutViews();
    });
}

// ============================================================
// 注入脚本: 标签 + 状态点 + 双击 + 断连检测 + 画面变化检测
// ============================================================
function getInjectJS(device, index) {
    const ui = CONFIG.ui || {};
    const labelColor = ui.labelColor || '#00ff00';
    const labelBg = ui.labelBg || 'rgba(0,0,0,0.75)';
    const showLabel = ui.showLabel !== false;
    const showDot = ui.showStatusDot !== false;

    return `
        (function() {
            // 移除旧的注入元素
            document.querySelectorAll('.__wall_overlay').forEach(el => el.remove());

            // 标签
            if (${showLabel}) {
                const label = document.createElement('div');
                label.className = '__wall_overlay';
                label.textContent = ${JSON.stringify(device.name)};
                label.style.cssText = 'position:fixed;top:3px;left:5px;z-index:99999;background:${labelBg};color:${labelColor};font:bold 13px Consolas,monospace;padding:2px 8px;border-radius:3px;pointer-events:none;white-space:nowrap';
                document.body.appendChild(label);
            }

            // 状态点 (绿=正常, 红=断连, 黄=重连中)
            if (${showDot}) {
                const dot = document.createElement('div');
                dot.id = '__wall_dot';
                dot.className = '__wall_overlay';
                dot.style.cssText = 'position:fixed;top:5px;right:5px;z-index:99999;width:8px;height:8px;border-radius:50%;background:#0f0;pointer-events:none;box-shadow:0 0 4px #0f0;transition:background 0.3s,box-shadow 0.3s';
                document.body.appendChild(dot);
            }

            // 双击刷新
            document.addEventListener('dblclick', function(e) {
                console.log('__WALL_DBLCLICK__:${index}');
            }, true);

            // ========== 断连检测系统 ==========

            // 1) WebSocket hook: 跟踪所有WS实例, 监听close/error
            var __wall_wsInstances = [];
            var __wall_OrigWS = window.WebSocket;
            window.WebSocket = function(url, protocols) {
                var ws = protocols ? new __wall_OrigWS(url, protocols) : new __wall_OrigWS(url);
                __wall_wsInstances.push(ws);
                ws.addEventListener('close', function() {
                    console.log('__WALL_DISCONNECT__:${index}');
                });
                ws.addEventListener('error', function() {
                    console.log('__WALL_DISCONNECT__:${index}');
                });
                return ws;
            };
            window.WebSocket.prototype = __wall_OrigWS.prototype;
            window.WebSocket.CONNECTING = __wall_OrigWS.CONNECTING;
            window.WebSocket.OPEN = __wall_OrigWS.OPEN;
            window.WebSocket.CLOSING = __wall_OrigWS.CLOSING;
            window.WebSocket.CLOSED = __wall_OrigWS.CLOSED;

            // Hook 已存在的 noVNC WebSocket
            try {
                var rfb = window.rfb || (window._noVNC && window._noVNC.rfb);
                if (rfb && rfb._sock && rfb._sock._websocket) {
                    __wall_wsInstances.push(rfb._sock._websocket);
                    rfb._sock._websocket.addEventListener('close', function() {
                        console.log('__WALL_DISCONNECT__:${index}');
                    });
                    rfb._sock._websocket.addEventListener('error', function() {
                        console.log('__WALL_DISCONNECT__:${index}');
                    });
                }
            } catch(e) {}

            // 2) 每30秒检查WebSocket状态 (处理静默断连)
            setInterval(function() {
                var hasOpen = false;
                __wall_wsInstances.forEach(function(ws) {
                    try {
                        if (ws.readyState === __wall_OrigWS.OPEN || ws.readyState === __wall_OrigWS.CONNECTING) {
                            hasOpen = true;
                        }
                    } catch(e) {}
                });
                // 有过WebSocket但现在全部关闭 = 断连
                if (__wall_wsInstances.length > 0 && !hasOpen) {
                    console.log('__WALL_DISCONNECT__:${index}');
                }
            }, 30000);

            // 3) 画面变化检测 (每30秒采样canvas, 3分钟无变化=断连)
            var __wall_lastCanvasKey = '';
            var __wall_noChangeCount = 0;
            setInterval(function() {
                try {
                    var canvas = document.querySelector('canvas');
                    if (!canvas) return;
                    var ctx = canvas.getContext('2d');
                    if (!ctx) return;
                    var w = Math.min(canvas.width, 32);
                    var h = Math.min(canvas.height, 32);
                    if (w === 0 || h === 0) return;
                    var data = ctx.getImageData(0, 0, w, h);
                    var key = w + 'x' + h + ':';
                    for (var j = 0; j < Math.min(data.data.length, 200); j += 4) {
                        key += data.data[j] + ',';
                    }
                    if (key === __wall_lastCanvasKey) {
                        __wall_noChangeCount++;
                        if (__wall_noChangeCount >= 6) {  // 6x30s = 3分钟无变化
                            console.log('__WALL_DISCONNECT__:${index}');
                            __wall_noChangeCount = 0;  // 报告后重置, 避免重复
                        }
                    } else {
                        __wall_noChangeCount = 0;
                    }
                    __wall_lastCanvasKey = key;
                } catch(e) {}
            }, 30000);
        })();
    `;
}

// ============================================================
// BrowserView 事件绑定 (提取为独立函数, 支持重建)
// ============================================================
function setupViewEvents(view, device, index) {
    // 页面加载完成 -> 注入标签和检测脚本
    view.webContents.on('did-finish-load', () => {
        const item = views[index];
        if (item && item._loadTimeout) {
            clearTimeout(item._loadTimeout);
            item._loadTimeout = null;
        }
        view.webContents.executeJavaScript(getInjectJS(device, index)).catch(() => {});
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('view-state', { index, state: 'ok' });
        }
    });

    // 加载失败
    view.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
        if (!isMain) return;
        const item = views[index];
        if (item && item._loadTimeout) {
            clearTimeout(item._loadTimeout);
            item._loadTimeout = null;
        }
        if (_debugMode) console.log(`[View] #${index} ${device.name} 加载失败: ${desc}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('view-state', { index, state: 'fail' });
        }
    });

    // 接收通知 (双击刷新 / 断连自动重连)
    view.webContents.on('console-message', (e, level, msg) => {
        if (!msg) return;
        if (msg.startsWith('__WALL_DBLCLICK__')) {
            const idx = parseInt(msg.split(':')[1], 10);
            refreshView(idx);
        }
        if (msg.startsWith('__WALL_DISCONNECT__')) {
            const idx = parseInt(msg.split(':')[1], 10);
            const item = views[idx];
            if (!item) return;
            // 状态点变红
            try {
                item.view.webContents.executeJavaScript(
                    `var d=document.getElementById('__wall_dot');if(d){d.style.background='#f00';d.style.boxShadow='0 0 4px #f00'}`
                ).catch(() => {});
            } catch(e) {}
            // 防抖: 8秒内不重复重连
            const now = Date.now();
            if (!item._lastReconnect || now - item._lastReconnect > 8000) {
                item._lastReconnect = now;
                if (_debugMode) console.log(`[AutoReconnect] #${idx} ${item.device.name} 断连, 5秒后重连...`);
                setTimeout(() => refreshView(idx), 5000);
            }
        }
    });
}

// ============================================================
// 创建所有 BrowserView
// ============================================================
function createAllViews() {
    const { devices, vnc } = CONFIG;
    const stagger = vnc.stagger || 300;

    devices.forEach((device, i) => {
        const view = new BrowserView({
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                partition: `persist:vnc-${i}`,  // 每个VNC独立session存储,完全隔离
            }
        });
        mainWindow.addBrowserView(view);
        views.push({ view, device, index: i, bounds: { x: 0, y: 0, width: 0, height: 0 } });

        setupViewEvents(view, device, i);

        // 错峰加载,避免25个同时连接服务器
        setTimeout(() => {
            const url = vnc.urlTemplate.replace(/\{ip\}/g, device.ip);
            view.webContents.loadURL(url);
        }, i * stagger);
    });
}

// ============================================================
// 布局
// ============================================================
function layoutViews() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { rows, cols, gap = 2 } = CONFIG.layout;
    const [winW, winH] = mainWindow.getContentSize();

    const cellW = Math.floor((winW - (cols + 1) * gap) / cols);
    const cellH = Math.floor((winH - (rows + 1) * gap) / rows);

    views.forEach(({ view, index }) => {
        const r = Math.floor(index / cols);
        const c = index % cols;
        if (r >= rows) return;  // 超出布局的不显示

        const x = gap + c * (cellW + gap);
        const y = gap + r * (cellH + gap);
        view.setBounds({ x, y, width: cellW, height: cellH });
        view.setAutoResize({ width: false, height: false });
    });

    if (mainWindow) {
        mainWindow.webContents.send('layout-update', {
            rows, cols, gap, cellW, cellH, winW, winH
        });
    }
}

// ============================================================
// 刷新单格 (缓存破坏 + 崩溃检测 + 超时重建)
// ============================================================
function refreshView(index) {
    const item = views[index];
    if (!item) return false;

    // 清除之前的加载超时
    if (item._loadTimeout) {
        clearTimeout(item._loadTimeout);
        item._loadTimeout = null;
    }

    // 如果 webContents 已崩溃或已销毁, 直接重建 BrowserView
    try {
        if (item.view.webContents.isCrashed() || item.view.webContents.isDestroyed()) {
            if (_debugMode) console.log(`[Refresh] #${index} ${item.device.name} webContents崩溃/销毁, 重建`);
            recreateView(index);
            return true;
        }
    } catch(e) {
        if (_debugMode) console.log(`[Refresh] #${index} ${item.device.name} webContents访问异常, 重建`);
        recreateView(index);
        return true;
    }

    const { vnc } = CONFIG;
    // 加 _t 缓存破坏, 确保 Chromium 不走缓存
    const url = vnc.urlTemplate.replace(/\{ip\}/g, item.device.ip) + '&_t=' + Date.now();
    item.view.webContents.loadURL(url);

    // 30秒加载超时 -> 重建 BrowserView
    item._loadTimeout = setTimeout(() => {
        item._loadTimeout = null;
        try {
            if (item.view.webContents && !item.view.webContents.isDestroyed()) {
                if (_debugMode) console.log(`[Refresh] #${index} ${item.device.name} 加载超时30s, 重建`);
                recreateView(index);
            }
        } catch(e) {
            recreateView(index);
        }
    }, 30000);

    return true;
}

// ============================================================
// 重建 BrowserView (彻底销毁旧的, 创建全新的)
// ============================================================
function recreateView(index) {
    const item = views[index];
    if (!item || !mainWindow || mainWindow.isDestroyed()) return;

    if (_debugMode) console.log(`[RecreateView] #${index} ${item.device.name} 重建BrowserView`);

    // 清除加载超时
    if (item._loadTimeout) {
        clearTimeout(item._loadTimeout);
        item._loadTimeout = null;
    }

    // 移除并销毁旧的 BrowserView
    try { mainWindow.removeBrowserView(item.view); } catch(e) {}
    try {
        const oldWC = item.view.webContents;
        if (oldWC && !oldWC.isDestroyed()) oldWC.close();
    } catch(e) {}

    // 创建新的 BrowserView
    const newView = new BrowserView({
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            partition: `persist:vnc-${index}`,
        }
    });
    mainWindow.addBrowserView(newView);

    // 更新引用
    item.view = newView;
    item._lastReconnect = 0;

    // 重新绑定事件
    setupViewEvents(newView, item.device, index);

    // 加载 URL (带缓存破坏)
    const { vnc } = CONFIG;
    const url = vnc.urlTemplate.replace(/\{ip\}/g, item.device.ip) + '&_t=' + Date.now();
    newView.webContents.loadURL(url);

    // 重新布局
    layoutViews();
}

// ============================================================
// 主进程健康检查 (每60秒检查所有 BrowserView 是否崩溃)
// ============================================================
function startHealthCheck() {
    setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        views.forEach((item, i) => {
            try {
                if (!item.view || !item.view.webContents ||
                    item.view.webContents.isCrashed() || item.view.webContents.isDestroyed()) {
                    if (_debugMode) console.log(`[HealthCheck] #${i} ${item.device.name} 异常, 重建`);
                    recreateView(i);
                }
            } catch(e) {
                if (_debugMode) console.log(`[HealthCheck] #${i} ${item.device.name} 访问异常, 重建`);
                recreateView(i);
            }
        });
    }, 60000);
}

// ============================================================
// IPC
// ============================================================
ipcMain.handle('refresh-view', (e, index) => refreshView(index));

ipcMain.handle('refresh-all', () => {
    const { vnc } = CONFIG;
    views.forEach((item, i) => {
        setTimeout(() => refreshView(i), i * (vnc.stagger || 300));
    });
    return true;
});

ipcMain.handle('toggle-fullscreen', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

ipcMain.handle('get-config', () => ({ config: CONFIG, path: CONFIG_PATH }));

// ============================================================
// 启动
// ============================================================
app.whenReady().then(() => {
    createMainWindow();
    startHealthCheck();
});

app.on('window-all-closed', () => app.quit());
