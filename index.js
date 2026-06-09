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
        // 把设备信息发给 overlay 用于绘制标签
        mainWindow.webContents.send('init-overlay', {
            devices: CONFIG.devices,
            layout: CONFIG.layout,
            ui: CONFIG.ui,
        });
    });
}

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

        // 注入标签和双击监听 (每次 did-finish-load 都重新注入)
        const injectOverlay = () => {
            const ui = CONFIG.ui || {};
            const labelColor = ui.labelColor || '#00ff00';
            const labelBg = ui.labelBg || 'rgba(0,0,0,0.75)';
            const showLabel = ui.showLabel !== false;
            const showDot = ui.showStatusDot !== false;
            const js = `
                (function() {
                    // 移除旧的注入元素
                    document.querySelectorAll('.__wall_overlay').forEach(el => el.remove());
                    if (${showLabel}) {
                        const label = document.createElement('div');
                        label.className = '__wall_overlay';
                        label.textContent = ${JSON.stringify(device.name)};
                        label.style.cssText = 'position:fixed;top:3px;left:5px;z-index:99999;background:${labelBg};color:${labelColor};font:bold 13px Consolas,monospace;padding:2px 8px;border-radius:3px;pointer-events:none;white-space:nowrap';
                        document.body.appendChild(label);
                    }
                    if (${showDot}) {
                        const dot = document.createElement('div');
                        dot.id = '__wall_dot';
                        dot.className = '__wall_overlay';
                        dot.style.cssText = 'position:fixed;top:5px;right:5px;z-index:99999;width:8px;height:8px;border-radius:50%;background:#0f0;pointer-events:none;box-shadow:0 0 4px #0f0';
                        document.body.appendChild(dot);
                    }
                    // 双击监听 -> 通过 console.log 通知 (主进程在 console-message 里接收)
                    document.addEventListener('dblclick', function(e) {
                        console.log('__WALL_DBLCLICK__:${i}');
                    }, true);

                    // WebSocket 断连检测 -> 自动通知主进程重连
                    var __wall_wsHooked = false;
                    function hookWebSocket() {
                        if (__wall_wsHooked) return;
                        // 延迟等 noVNC 创建 WebSocket
                        setTimeout(function() {
                            var wsList = [];
                            // 拦截 WebSocket 构造
                            var OrigWS = window.WebSocket;
                            window.WebSocket = function(url, protocols) {
                                var ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
                                wsList.push(ws);
                                ws.addEventListener('close', function() {
                                    console.log('__WALL_DISCONNECT__:${i}');
                                });
                                ws.addEventListener('error', function() {
                                    console.log('__WALL_DISCONNECT__:${i}');
                                });
                                return ws;
                            };
                            window.WebSocket.prototype = OrigWS.prototype;
                            window.WebSocket.CONNECTING = OrigWS.CONNECTING;
                            window.WebSocket.OPEN = OrigWS.OPEN;
                            window.WebSocket.CLOSING = OrigWS.CLOSING;
                            window.WebSocket.CLOSED = OrigWS.CLOSED;
                            // 也 hook 已存在的 WebSocket 实例
                            try {
                                var rfb = (window.rfb || (window._noVNC && window._noVNC.rfb));
                                if (rfb && rfb._sock && rfb._sock._websocket) {
                                    rfb._sock._websocket.addEventListener('close', function() {
                                        console.log('__WALL_DISCONNECT__:${i}');
                                    });
                                    rfb._sock._websocket.addEventListener('error', function() {
                                        console.log('__WALL_DISCONNECT__:${i}');
                                    });
                                }
                            } catch(e) {}
                            __wall_wsHooked = true;
                        }, 2000);
                    }
                    hookWebSocket();

                    // 状态点颜色更新
                    function __wallUpdateDot(color) {
                        var dot = document.getElementById('__wall_dot');
                        if (dot) dot.style.background = color;
                    }
                })();
            `;
            view.webContents.executeJavaScript(js).catch(() => {});
        };

        view.webContents.on('did-finish-load', () => {
            injectOverlay();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('view-state', { index: i, state: 'ok' });
            }
        });
        view.webContents.on('did-fail-load', () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('view-state', { index: i, state: 'fail' });
            }
        });
        // 接收 BrowserView 内的通知 (双击刷新 / 断连自动重连)
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
                item.view.webContents.executeJavaScript(
                    `var d=document.getElementById('__wall_dot');if(d){d.style.background='#f00';d.style.boxShadow='0 0 4px #f00'}`
                ).catch(() => {});
                // 防抖: 5秒内不重复重连
                const now = Date.now();
                if (!item._lastReconnect || now - item._lastReconnect > 5000) {
                    item._lastReconnect = now;
                    if (_debugMode) console.log(`[AutoReconnect] #${idx} ${item.device.name} 断连, 5秒后重连...`);
                    setTimeout(() => refreshView(idx), 5000);
                }
            }
        });

        // 错峰加载,避免25个同时连接服务器
        setTimeout(() => {
            const url = vnc.urlTemplate.replace(/\{ip\}/g, device.ip);
            view.webContents.loadURL(url);
        }, i * stagger);
    });
}

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

    // 通知 overlay 重新画标签
    if (mainWindow) {
        mainWindow.webContents.send('layout-update', {
            rows, cols, gap, cellW, cellH, winW, winH
        });
    }
}

// ============================================================
// 刷新单格
// ============================================================
function refreshView(index) {
    const item = views[index];
    if (!item) return false;
    const { vnc } = CONFIG;
    const url = vnc.urlTemplate.replace(/\{ip\}/g, item.device.ip);
    item.view.webContents.loadURL(url);
    return true;
}

ipcMain.handle('refresh-view', (e, index) => refreshView(index));

ipcMain.handle('refresh-all', () => {
    const { vnc } = CONFIG;
    views.forEach((item, i) => {
        setTimeout(() => {
            const url = vnc.urlTemplate.replace(/\{ip\}/g, item.device.ip);
            item.view.webContents.loadURL(url);
        }, i * (vnc.stagger || 300));
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
app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => app.quit());
