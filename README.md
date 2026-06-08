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
    "stagger": 300
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

行×列 ≥ 设备数。多余的格子保留空白；不够的设备被截断。

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
| `stagger` | 设备启动错峰间隔（毫秒），避免 25 路同时连接卡顿 | 300 |

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
| 双击单个格子 | 刷新该格 VNC（断线黑屏时用）|
| F5 | 刷新全部 VNC |
| F11 | 切换全屏 |

## 启动参数

| 参数 | 说明 |
|---|---|
| `--debug` | 打开主窗口 DevTools |

## 内存监控

启动后可在 Windows 任务管理器看到多个 `NoVNC Screen Wall.exe` 进程：
- 1 个主进程（GPU + 主窗口）
- N 个渲染进程（每个 VNC 一个）

每个 VNC 进程稳定在 100-200MB 上下波动（被 `--max-old-space-size=256` 限制），不会无限增长。即使个别进程因为某次 VNC 异常崩溃，其他进程不受影响，崩溃的格子自动空白，可双击或 F5 刷新恢复。

## 技术细节

- **进程隔离**: 每个 `BrowserView` 一个渲染进程（基于 Chromium 的 site-per-process 策略）
- **会话隔离**: 每个 view 用独立的 `partition: persist:vnc-N`，Cookie/缓存/Storage 不互相污染
- **错峰启动**: 按 `vnc.stagger` 间隔分别 `loadURL`，避免 25 路同时握手
- **标签注入**: 通过 `webContents.executeJavaScript` 注入设备名标签和双击监听到 VNC 页面
- **双击通信**: BrowserView 内部 `dblclick` → `console.log('__WALL_DBLCLICK__:N')` → 主进程 `console-message` 事件接收 → `webContents.loadURL` 刷新

## 许可证

ISC
