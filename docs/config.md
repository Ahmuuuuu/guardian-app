# 房间配置系统设计

---

## 1. 配置层级

```
runtime-state-service.js 内置默认值 (defaultRoomConfig)
    │
    └── 教师创建房间时覆盖 ──→ 房间配置 (内存 Map，不落盘)
              │
              └── 教师实时指令覆盖 ──→ 运行时配置 (直接修改 room 对象)
```

**合并规则**: 运行时指令 覆盖 → 房间存储配置 覆盖 → 代码默认值

当前所有房间配置存储在内存 `store/memory.js` 的 `rooms` Map 中，服务器重启后丢失。不存在 JSON 文件持久化。

---

## 2. 代码默认配置

定义在 `server/service/runtime/runtime-state-service.js` 的 `defaultRoomConfig()` 中：

```js
{
  guard: {
    checkInterval: 3000,       // 检测间隔 (ms)，范围 [1000, 30000]
    notifyOnly: false,          // true=仅通知不强杀
    autoStartGuard: true        // 绑定后自动启动守卫
  },
  schedule: {
    autoMode: false,            // 到点自动启停（暂未实现定时逻辑）
    gracePeriod: 15,            // 迟到宽容 (分钟)
    allowLateJoin: true         // 宽容期后仍可加入
  },
  whitelist: {
    processes: [],              // 允许进程名数组
    browsers: [],               // 允许浏览器名数组
    urls: []                    // 允许 URL 数组
  },
  violations: {
    maxAllowed: 0               // 0 = 不限制违规次数
  }
}
```

### 创建时覆盖

```js
// runtime-state-service.js mergeRoomConfig()
// 传入的字段覆盖默认值，缺失字段保留默认
{
  guard: { ...defaults.guard, ...source.guard },
  schedule: { ...defaults.schedule, ...source.schedule },
  whitelist: {
    processes: source.whitelist?.processes || defaults.whitelist.processes,
    browsers:  source.whitelist?.browsers  || defaults.whitelist.browsers,
    urls:      source.whitelist?.urls      || defaults.whitelist.urls
  },
  violations: { ...defaults.violations, ...source.violations }
}
```

---

## 3. 房间完整配置结构

```typescript
interface Room {
  id: string;                    // "r_a1b2c3d4", 随机生成
  roomName: string;              // 如 "301 机房"
  joinCode: string;              // 6 位大写接入码，字母去 I/O，数字去 0/1
  teacherId: string;             // 所属教师 ID
  createdAt: string;             // ISO 8601

  guard: GuardConfig;
  schedule: ScheduleConfig;
  whitelist: RoomWhitelist;
  violations: ViolationConfig;

  students: Student[];           // 本房间注册学生
  clients: Map<string, Client>;  // 本房间在线子机 (内存)
}

interface GuardConfig {
  checkInterval: number;         // 检测间隔 ms
  notifyOnly: boolean;
  autoStartGuard: boolean;
}

interface ScheduleConfig {
  autoMode: boolean;             // 到点自动启停
  gracePeriod: number;           // 迟到宽容 (分钟)
  allowLateJoin: boolean;        // 宽容期后仍可加入
}

interface ViolationConfig {
  maxAllowed: number;            // 0 = 不限制，N = 允许 N 次后触发策略
}

interface Student {
  studentId: string;             // 学号，同一房间内唯一
  name: string;                  // 姓名
}
```

---

## 4. 白名单结构

白名单作为房间配置的一部分，由三个数组组成：

```typescript
interface RoomWhitelist {
  processes: string[];           // 进程名，如 ["notepad.exe", "exam.exe"]
  browsers: string[];            // 浏览器名，如 ["chrome.exe", "msedge.exe"]
  urls: string[];                // 允许域名，如 ["exam.xxx.com"]
}
```

> 注：当前实现中数组元素为简单字符串。后续可扩展为对象格式 `{ name, path?, description?, enabled }`。

### 白名单匹配流程

```
子机上报违规检测 (进程名 / URL)
  │
  ├─ 命中 processes[] (大小写不敏感)
  │     └─ 放行
  │
  ├─ 命中 browsers[] (大小写不敏感)
  │     ├─ 有 URL 检测需求 → 匹配 urls[]
  │     └─ 无 URL 检测需求 → 放行
  │
  └─ 未命中任何白名单 → 违规
```

---

## 5. 存储示例

### SQLite — admins + teachers（持久化）

```sql
-- admins: 管理员账号
id         TEXT PRIMARY KEY,    -- "a_xxx"
username   TEXT UNIQUE NOT NULL,
password   TEXT NOT NULL,       -- SHA256 哈希
created_at TEXT NOT NULL;

-- teachers: 教师账号
id         TEXT PRIMARY KEY,    -- "t_xxx"
staff_id   TEXT UNIQUE NOT NULL,
name       TEXT NOT NULL,
password   TEXT NOT NULL,       -- SHA256 哈希
created_at TEXT NOT NULL;
```

### 内存 — rooms + clients

```
rooms Map (roomId → Room)
├─ "r_a1b2c3" → Room {
│    roomName: "301 机房",
│    joinCode: "A7K2F3",
│    students: [ { studentId:"2024001", name:"张三" }, ... ],
│    clients: Map (clientId → ClientInfo)
│     └─ "c_xxx1" → { studentId, ws, ip, guardActive, ... }
│  }
└─ ...

clientRoomIndex Map (clientId → roomId)     ← 反查索引
clients Map (clientId → ClientInfo)         ← 全局子机索引（含未绑定）
```

### ClientInfo（纯内存，不持久化）

```js
{
  ws: <WebSocket>,
  ip: "192.168.1.10",
  clientId: "c_a1b2c3",
  studentId: "2024001",
  studentName: "张三",
  hostname: "PC-01",
  roomId: "r_a1b2c3d4",
  guardActive: true,
  processCount: 8,
  violations: [],
  lastSeen: 1745568000000,
  bindAt: 1745568000000
}
```

---

## 6. 配置变更传播路径

```
教师端 UI                       服务器 (只改内存，不写磁盘)
  │                               │
  │ PUT /api/rooms/:id            │
  │ { whitelist: [...] }          │
  │ ─────────────────────────────►│
  │                               ├─ state.updateRoom() → 直接改 room 对象
  │                               ├─ 教师可选择性下发到在线子机
  │                               │
  │                               │ POST .../clients/:cid/update-whitelist
  │                               │ WS { update-whitelist, whitelist }
  │                               │ ──────────────────────────►
  │                               │    main.js 更新白名单
  │                               │
  │ ◄── { ok: true, room: {...} } │
```

```
教师端 UI                       服务器
  │                               │
  │ POST /api/rooms/:id/start     │
  │ ─────────────────────────────►│
  │                               ├─ state.sendToRoom(roomId, { toggle-guard, enabled: true })
  │                               │
  │                               │ WS { toggle-guard, enabled: true }
  │                               │ ──────────────────────────►
  │                               │    main.js 启动守卫
  │                               │
  │ ◄── { ok: true, sent: 30 }    │
```

---

## 7. WebSocket 准入控制参数（WS_ADMISSION_*）

为缓解瞬时连接风暴导致的 `ECONNREFUSED`，当前服务端采用三层缓冲：

- Layer 1: TCP backlog（`server.listen(PORT, 1024)`）
- Layer 2: Connection Admission Control（令牌桶 + 队列 + 单 IP 限额）
- Layer 3: 现有 `wss.on('connection')` 业务处理

环境文件与加载顺序：

- `server/.env`：基础参数（默认加载）
- `server/.env.development`：开发参数（当 `NODE_ENV=development` 时覆盖 `.env`）

### 7.1 环境变量说明

基础服务参数：

| 环境变量 | 默认值 | 注释（作用） |
|---|---:|---|
| `GUARDIAN_SERVER_PORT` | `3847` | 服务端监听端口。`server/src/server.js` 使用该参数启动 HTTP + WebSocket 服务。 |
| `GUARDIAN_SERVER_URL` | `http://localhost:3847` | 桌面端（Electron）加载的服务地址。 |

WebSocket 准入参数：

| 环境变量 | 默认值 | 注释（作用） |
|---|---:|---|
| `WS_ADMISSION_MAX_CONCURRENT` | `100` | 同时处于握手处理中的连接上限（并发 `handleUpgrade` 数）。值越大吞吐越高，但更容易挤占事件循环。 |
| `WS_ADMISSION_PER_SEC` | `200` | 每秒准入速率（令牌补充速率）。超过速率的升级请求进入队列等待。 |
| `WS_ADMISSION_MAX_QUEUE` | `500` | 升级等待队列最大长度。超过后直接返回 `503`，并附带 `Retry-After`。 |
| `WS_ADMISSION_MAX_PER_IP` | `20` | 单 IP 在“队列+处理中”总配额，防止单来源打满全局准入队列。 |
| `WS_ADMISSION_RETRY_AFTER_SEC` | `2` | 被限流时响应头 `Retry-After` 秒数，提示客户端退避后重试。 |
| `WS_ADMISSION_QUEUE_TIMEOUT_MS` | `10000` | 请求在准入队列中的最大等待时间。超时后返回 `503`。 |
| `WS_ADMISSION_LOOPBACK_BYPASS` | `1`（默认开启） | 是否对回环地址（`127.0.0.1`/`::1`）绕过 `MAX_PER_IP` 限制。设为 `0` 可关闭（本机测试设为1）。 |

### 7.2 调参建议

- 压测/单机模拟优先确保 `WS_ADMISSION_LOOPBACK_BYPASS=1`，否则会被单 IP 限额提前卡住。
- 如果排队较多但机器还有余量，先小步提高 `WS_ADMISSION_MAX_CONCURRENT`（例如 `100 -> 120 -> 150`）。
- 如果 `503` 明显偏多且希望更快放行，逐步提高 `WS_ADMISSION_PER_SEC`。
- 如果波峰很短，可适当提高 `WS_ADMISSION_MAX_QUEUE`；如果不希望请求等太久，可降低 `WS_ADMISSION_QUEUE_TIMEOUT_MS`。

### 7.3 示例

Linux/macOS:

```bash
export WS_ADMISSION_MAX_CONCURRENT=120
export WS_ADMISSION_PER_SEC=240
export WS_ADMISSION_MAX_QUEUE=800
export WS_ADMISSION_MAX_PER_IP=30
export WS_ADMISSION_RETRY_AFTER_SEC=2
export WS_ADMISSION_QUEUE_TIMEOUT_MS=12000
export WS_ADMISSION_LOOPBACK_BYPASS=1
export GUARDIAN_SERVER_PORT=3847
export GUARDIAN_SERVER_URL=http://localhost:3847
node server/src/server.js
```

Windows PowerShell:

```powershell
$env:WS_ADMISSION_MAX_CONCURRENT = "120"
$env:WS_ADMISSION_PER_SEC = "240"
$env:WS_ADMISSION_MAX_QUEUE = "800"
$env:WS_ADMISSION_MAX_PER_IP = "30"
$env:WS_ADMISSION_RETRY_AFTER_SEC = "2"
$env:WS_ADMISSION_QUEUE_TIMEOUT_MS = "12000"
$env:WS_ADMISSION_LOOPBACK_BYPASS = "1"
$env:GUARDIAN_SERVER_PORT = "3847"
$env:GUARDIAN_SERVER_URL = "http://localhost:3847"
node server\src\server.js
```
