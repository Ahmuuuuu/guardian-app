# Guardian 通信协议

覆盖三个端：**管控服务器** (Express + WS)、**教师端** (浏览器)、**学生端** (Electron)

---

## 1. 系统拓扑

```
┌────────────────────────────────────────────────────────────┐
│  教师端                                                      │
│  ┌─────────────────┐                                        │
│  │  浏览器           │                                       │
│  │  control.html    │                                       │
│  │  localhost:3847  │                                       │
│  └────────┬────────┘                                        │
│           │ HTTP REST (JSON)                                │
└───────────┼────────────────────────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────────────────────┐
│  管控服务器 (port 3847)                                      │
│                                                              │
│  HTTP Server ── Express ── REST API                          │
│                                                             │
│  WebSocket Server ── /guardian-ws                            │
│                                                             │
│  Data: SQLite (admins/teachers), In-Memory Map (rooms/clients)              │
└───────────┼────────────────────────────────────────────────┘
            │ WebSocket /guardian-ws
            ▼
┌────────────────────────────────────────────────────────────┐
│  学生端 (Electron)                                           │
│                                                              │
│  main.js ─── 守卫循环 (PowerShell + 白名单比对)               │
│     │                                                        │
│  preload.js ─── contextBridge (IPC 安全桥梁)                   │
│     │                                                        │
│  renderer/index.html ─── 学生机 UI                           │
│     │                                                        │
│  remote-client.js ─── WebSocket 客户端                       │
└────────────────────────────────────────────────────────────┘
```

---

## 2. WebSocket 协议 (管控服务器 ↔ 学生端)

### 2.1 连接生命周期

```
┌──────────────┐                              ┌──────────────────┐
│   学生机      │                              │   管控服务器       │
│  (Electron)  │                              │  (Express + WS)  │
└──────┬───────┘                              └────────┬─────────┘
       │                                              │
       │     1. WS connect /guardian-ws ────────────► │
       │                                              │
       │  ◄── 2. { type: "welcome",                  │
       │           clientId: "c_a1b2c3" }             │
       │                                              │
       │  ═══════ 30s 超时窗口 ═══════                │
       │       超时未 bind → 服务端断开连接              │
       │                                              │
       │     3. { type: "bind",                      │
       │           roomCode: "A7K2F3",                │
       │           studentId: "2024001",              │
       │           name: "张三",               │
       │           hostname: "PC-01" } ─────────────► │
       │                                              │
       │                    验证 roomCode              │
       │                    记录 studentId + IP        │
       │                    绑定到 room                │
       │                                              │
       │  ◄── 4. { type: "bind-ack",                 │
       │           ok: true,                          │
       │           roomId: "r_301", roomName: "301 机房" }                  │
       │           (或 { ok: false, msg: "..." })     │
       │                                              │
       │  ═══════ 考试进行中 ═══════                  │
       │                                              │
       │     5. { type: "heartbeat",                 │
       │           guardActive: true,                 │
       │           processCount: 8,                   │
       │           violations: [...] } ─────────────► │
       │                                              │
       │  ◄── 6. { type: "heartbeat-ack" }            │
       │                                              │
       │  ◄── 7. { type: "toggle-guard",             │
       │           enabled: true }  (教师指令)         │
       │                                              │
       │  ◄── 8. { type: "update-whitelist",         │
       │           whitelist: {...} } (教师指令)       │
       │                                              │
       │  ◄── 9. { type: "force-kill-process",       │
       │           pid: 1234 }  (教师指令)             │
       │                                              │
       │  ◄── 10. { type: "broadcast",               │
       │            message: "离考试结束还有 5 分钟" } │
       │                                              │
       │  ═══════ 考试结束 ═══════                    │
       │                                              │
       │  ── 11. WS disconnect ────────────────────► │
       │                    服务端标记离线              │
```

### 2.2 消息类型总表

#### 学生机 → 管控服务器

| 序号 | type | 发送时机 | 载荷 | 服务端响应 |
|------|------|----------|------|-----------|
| 1 | `bind` | 连接后 30s 内 | `{ roomCode, studentId, name, hostname }` | → `bind-ack` |
| 2 | `heartbeat` | 每 5s | `{ guardActive, processCount, violations[] }` | → `heartbeat-ack` |
| 3 | `violation-log` | 发现违规时 | `{ violations[] }` | 无 |

#### 管控服务器 → 学生机

| 序号 | type | 发送时机 | 载荷 | 说明 |
|------|------|----------|------|------|
| 1 | `welcome` | WS 连接成功 | `{ clientId }` | 标识该连接 |
| 2 | `bind-ack` | bind 处理完 | `{ ok, roomId, roomName }` 或 `{ ok:false, msg }` | — |
| 3 | `heartbeat-ack` | 收到 heartbeat | `{}` | 仅确认 |
| 4 | `toggle-guard` | 教师远程开关 | `{ enabled: boolean }` | — |
| 5 | `update-whitelist` | 教师下发白名单 | `{ whitelist: RoomWhitelist }` | — |
| 6 | `force-kill-process` | 教师结束进程 | `{ pid: number }` | — |
| 7 | `broadcast` | 教师发通知 | `{ message: string }` | 透传给子机 |

### 2.3 服务端状态处理逻辑

```
新 WS 连接
  │
  ├─ 生成 clientId
  ├─ 写入 clients Map: { ws, ip, clientId, studentId, roomId, ... }
  ├─ 发送 welcome
  └─ 启动 30s bind 超时定时器
       │
       ├─ 30s 内收到 bind → 清除定时器
       │     ├─ 验证 roomCode → 查内存 store
       │     ├─ 检查 studentId 是否已在该 room 中在线
       │     ├─ 记录 IP 和绑定时间
       │     ├─ clients[clientId] 更新 studentId + roomId
       │     ├─ 发送 bind-ack { ok: true }
       │     └─ 教师端收到实时推送 (新子机上线)
       │
       └─ 30s 超时 → 关闭 WS 连接，清理 clients
```

### 2.4 异常处理

| 场景 | 行为 |
|------|------|
| WS 断开 | 服务端清理 clients，教师端实时看到离线 |
| 服务端宕机 | 学生端 5s 自动重连，无限重试 |
| bind 失败 (roomCode 无效) | 返回 `{ ok: false, msg: "房间码无效" }`，不关闭连接，允许重试 |
| studentId 重复绑定 | 踢掉旧连接，新连接接管 |
| 心跳超时 120s | 服务端主动 terminate，清除 clients |

---

## 3. REST API (教师端 → 管控服务器)

### 3.1 通用约定

- **Base URL**: `http://{server}:3847`
- **Content-Type**: `application/json`
- **认证**: 除 login 外，所有请求 header 带 `x-token`
- **统一响应**: `{ ok: boolean, ...数据 }` 或 `{ ok: false, msg: string }`

### 3.2 API 路径总表

#### 认证

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | /api/admin/login | 否 | 管理员登录 |

登录返回: `{ ok: true, token: string, role: "admin", username: string }`

#### 房间管理 (需认证)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/rooms` | 获取当前教师的所有房间 |
| POST | `/api/rooms` | 创建房间 |
| GET | `/api/rooms/:id` | 房间详情 (含状态摘要) |
| PUT | `/api/rooms/:id` | 更新房间配置 |
| DELETE | `/api/rooms/:id` | 删除房间 (房间内无在线子机时) |

`POST /api/rooms` body:

```json
{
  "roomName": "301 机房",
  "guard": {
    "checkInterval": 3000,
    "notifyOnly": false,
    "autoStartGuard": true
  },
  "schedule": {
    "autoMode": false,
    "gracePeriod": 15,
    "allowLateJoin": true
  },
  "whitelist": {
    "processes": [
      { "name": "notepad.exe", "description": "记事本", "enabled": true },
      { "name": "exam.exe", "path": "C:\\Exam\\exam.exe", "description": "考试系统", "enabled": true }
    ],
    "browsers": [
      { "name": "chrome.exe", "description": "用于访问考试系统", "enabled": true }
    ],
    "urls": [
      { "pattern": "exam.xxx.com", "type": "allow", "description": "考试服务器" },
      { "pattern": "*.baidu.com", "type": "deny", "description": "禁止搜索" }
    ]
  },
  "violations": {
    "maxAllowed": 0
  }
}
```

#### 房间控制 (需认证)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/rooms/:id/start` | 启动考试 (给房间内所有在线子机发 toggle-guard) |
| POST | `/api/rooms/:id/stop` | 停止考试 (发 toggle-guard false) |
| POST | `/api/rooms/:id/broadcast` | 广播给本房间所有在线子机 |

#### 房间内子机管控 (需认证)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/rooms/:id/clients` | 本房间在线子机列表 |
| POST | `/api/rooms/:id/clients/:cid/toggle-guard` | 开关指定子机守卫 |
| POST | `/api/rooms/:id/clients/:cid/kill` | 结束指定子机的进程 |
| POST | `/api/rooms/:id/clients/:cid/update-whitelist` | 下发白名单到指定子机 |





