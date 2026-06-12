# NoVNC 屏幕墙 (novnc-screen-wall)

基于 Electron 的 NoVNC 屏幕墙客户端，每个 VNC 设备使用独立的 Chromium 渲染进程，从根源解决浏览器版屏幕墙长时间运行内存暴涨的问题。

## 为什么不用浏览器版屏幕墙

浏览器单 tab 25 个 iframe 共享同一个渲染进程：
- 所有 VNC 的帧数据、Canvas、WebSocket 缓冲堆在同一个 V8 堆里
- GC 触发阈值高，回收效率低
- 子帧资源持有策略激进 → 内存只涨不降 → 系统卡死

本项目方案：
- 每个 VNC 是独立的 `BrowserView`（独立 Chromium 渲染进程）
- 独立的 V8 堆、独立的 GC，单个进程内存可控
- 强制 `--max-old-space-size=256`，单进程超 256MB 强制 GC
- `partition: persist:vnc-N` 让每个 VNC 独立 session，完全隔离

## 安装与运行

### 开发模式
```bash
npm install
npm start
```

### 打包 Windows 版本
```bash
npm run build:win
```
输出在 `dist/win-unpacked/`，双击 `NoVNC Screen Wall.exe` 启动。

## 配置文件

`配置文件.json` 与 exe 同目录，启动时自动读取。

### 完整示例
```json
{
  "layout": { "rows": 5, "cols": 5, "gap": 2 },
  "window": {
    "fullscreen": false,
    "width": 1920,
    "height": 1080,
    "title": "NoVNC 屏幕墙",
    "backgroundColor": "#111111"
  },
  "devices": [
    { "name": "Se2 A1", "ip": "172.16.103.1" },
    { "name": "Se2 A2", "ip": "172.16.103.2" }
  ],
  "vnc": {
    "urlTemplate": "http://{ip}:5801/vnc_video.html?autoconnect=true&host={ip}&port=5901&encrypt=0",
    "stagger": 800
  },
  "ui": {
    "showLabel": true,
    "labelColor": "#00ff00",
    "labelBg": "rgba(0,0,0,0.75)",
    "showStatusDot": true
  }
}
```

### 配置字段说明

#### `layout` — 网格布局
| 字段 | 说明 | 默认 |
|---|---|---|
| `rows` | 行数 | 5 |
| `cols` | 列数 | 5 |
| `gap` | 单元格间距（像素） | 2 |

行 x 列 >= 设备数。多余的格子保留空白；不够的设备被截断。

#### `window` — 主窗口
| 字段 | 说明 | 默认 |
|---|---|---|
| `fullscreen` | 是否启动即全屏 | false |
| `width` | 窗口宽（非全屏时生效） | 1920 |
| `height` | 窗口高 | 1080 |
| `title` | 窗口标题 | NoVNC 屏幕墙 |
| `backgroundColor` | 背景色 | #111111 |

#### `devices` — 设备列表
数组，每项 `{ name, ip }`：
- `name`: 显示在格子左上角的标签
- `ip`: 代入 `vnc.urlTemplate` 的 `{ip}` 占位符

#### `vnc` — VNC 连接
| 字段 | 说明 | 默认 |
|---|---|---|
| `urlTemplate` | URL 模板，`{ip}` 会被替换为设备 IP | `http://{ip}:5801/vnc_video.html?...` |
| `stagger` | 设备启动错峰间隔（毫秒），避免 25 路同时连接卡顿 | 800 |

#### `ui` — 界面外观
| 字段 | 说明 | 默认 |
|---|---|---|
| `showLabel` | 显示设备名标签 | true |
| `labelColor` | 标签字体颜色 | #00ff00 |
| `labelBg` | 标签背景 | rgba(0,0,0,0.75) |
| `showStatusDot` | 显示右上角连接状态点 | true |

## 操作

| 操作 | 说明 |
|---|---|
| 双击单个格子 | 重建该格 BrowserView（断线/灰屏时用） |
| F5 | 重建全部 VNC（错峰） |
| F11 | 切换全屏 |

## 启动参数

| 参数 | 说明 |
|---|---|
| `--debug` | 打开主窗口 DevTools，控制台输出调试日志 |

## 断连检测与自动恢复

### 检测机制（三重保障）

1. **WebSocket 事件检测**
   - Hook WebSocket 构造函数，监听 `close` / `error` 事件
   - 同时 Hook noVNC 已有的 RFB WebSocket 实例
   - 触发后状态点变红，5 秒后自动重建 BrowserView（8 秒防抖，避免重复重建）

2. **WebSocket readyState 轮询**
   - 每 30 秒检查所有 WS 实例的 `readyState`
   - 有过 WS 连接但现在全部非 OPEN/CONNECTING = 静默断连
   - 处理 TCP 连接还在但实际已断的情况（WS close/error 事件不触发）

3. **灰屏检测（加载后 15 秒一次性检查）**
   - **优先检查 noVNC RFB 连接状态**：查找 `_rfbConnectionState` / `connectionState`，如果是 `disconnected` / `failed` / `error` 则判定断连
   - **RFB 连接正常则跳过画面检查**：画面静止是正常现象，不代表断连
   - **无 RFB 对象时检查 Canvas 颜色**：严格条件 — RGB 三通道差值 < 10 且均值 170-230 且 90% 以上像素命中，只匹配 noVNC 断连特有的均匀灰色背景
   - 检测到灰屏后 3 秒自动重建 BrowserView

> **重要**: 画面静止不等于断连。游戏窗口长时间无操作但画面不变是正常状态，不应触发刷新。灰屏检测只在加载后执行一次，不会反复检测。

### 自动重试（加载失败时）

- `did-fail-load` 事件触发后自动重试
- 第 1-3 次：仅 `loadURL` 重试，间隔 5s / 10s / 15s
- 第 4-6 次：销毁并重建 BrowserView，间隔 10s / 20s / 30s
- 超过 6 次放弃，等待用户双击或健康检查触发

### 健康检查

- 主进程每 60 秒遍历所有 BrowserView
- 检测 `isCrashed()` / `isDestroyed()` 状态
- 异常的 BrowserView 自动重建

### 重建 vs 刷新

双击格子或自动恢复时都是**重建 BrowserView**（`recreateView`），不是简单的 `loadURL`：
- 销毁旧的 BrowserView 及其渲染进程
- 创建全新的 BrowserView（新进程）
- 重新加载 URL（带 `_t=timestamp` 缓存破坏）
- 重新注入标签和检测脚本

比 `loadURL` 更彻底，能解决 BrowserView 崩溃/冻结等 `loadURL` 无法恢复的情况。

## 内存监控

启动后可在 Windows 任务管理器看到多个 `NoVNC Screen Wall.exe` 进程：
- 1 个主进程（GPU + 主窗口）
- N 个渲染进程（每个 VNC 一个）

每个 VNC 进程稳定在 100-200MB 上下波动（被 `--max-old-space-size=256` 限制），不会无限增长。即使个别进程因为某次 VNC 异常崩溃，其他进程不受影响，崩溃的格子自动空白，可双击或 F5 刷新恢复。

## 技术细节

- **进程隔离**: 每个 `BrowserView` 一个渲染进程（基于 Chromium 的 site-per-process 策略）
- **会话隔离**: 每个 view 用独立的 `partition: persist:vnc-N`，Cookie/缓存/Storage 不互相污染
- **错峰启动**: 按 `vnc.stagger` 间隔分别 `loadURL`，避免 25 路同时握手导致 VNC 服务器过载
- **标签注入**: 通过 `webContents.executeJavaScript` 在 `did-finish-load` 后注入设备名标签、状态点和检测脚本
- **双击通信**: BrowserView 内 `dblclick` -> `console.log('__WALL_DBLCLICK__:N')` -> 主进程 `console-message` 事件 -> `recreateView(N)`
- **断连通信**: BrowserView 内 `console.log('__WALL_DISCONNECT__:N')` 或 `__WALL_GREY__:N` -> 主进程接收 -> 自动重建
- **状态点**: 绿色 = 正常连接，红色 = 断连/重连中
- **缓存破坏**: 重建时 URL 带 `&_t=timestamp` 参数，避免浏览器缓存旧页面

## 许可证

ISC
