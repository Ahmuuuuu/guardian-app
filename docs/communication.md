# Guardian 通信架构文档

覆盖三个端：**管控服务器**、**教师端**（浏览器 + Electron）、**学生端**（Electron）

> 详细规范见 `docs/protocol.md`（通信协议）和 `docs/tech-stack.md`（技术栈方案）。

---

## 1. 系统拓扑

```
┌────────────────────────────────────────────────────────────────┐
│                     管控服务器 (guardian-server)                   │
│                                                                 │
│  HTTP Layer               WS Layer           Storage Layer      │
│  ┌──────────┐       ┌───────────────┐       ┌──────────────┐   │
│  │ REST API │       │  WS Gateway   │       │  SQLite      │   │
│  │ (Express)│       │  /guardian-ws │       │  (admins +   │   │
│  │          │       │               │       │   teachers)  │   │
│  │ admin 认证│       │  bind / 心跳   │       │              │   │
│  │ 教师 CRUD │       │ 违规上报       │       │ In-Memory Map│   │
│  │ 房间 CRUD │       │ 指令下发       │       │ (rooms +     │   │
│  │ 静态页    │       │               │       │  clients)    │   │
│  └────┬─────┘       └──────┬────────┘       └──────────────┘   │
└───────┼────────────────────┼──────────────────────────────────┘
        │ HTTP               │ WS
        │                    │
   ┌────┴────────┐    ┌──────┴──────────┐    ┌────────────────┐
   │ 教师端(浏览器)│    │ 教师端(Electron) │    │ 学生端(Electron) │
   │             │    │                 │    │                │
   │ HTTP CRUD   │    │ HTTP + WS       │    │ WS 直连         │
   │ WS 订阅通知  │    │ (实时监控)       │    │ (心跳+守卫循环)  │
   └─────────────┘    └─────────────────┘    └────────────────┘
```

角色体系：
- **admin**（系统管理员）：管理教师账号，查看全局房间，不可直接操作房间守卫
- **teacher**（教师）：管理自己的房间、学生名单、下发指令
- **student**（学生机客户端）：WS 连接，心跳上报，接收指令

---

## 2. 通信总览

| 链路 | 协议 | 方向 | 说明 |
|------|------|------|------|
| 教师端 ↔ 管控服务器 | **HTTP REST** (JSON) | 双向 | 管理员登录、教师 CRUD、房间 CRUD、学生管理 |
| 学生端 ↔ 管控服务器 | **WebSocket** (JSON) | 全双工 | 心跳上报、违规上报、接收指令 |

教师端 HTTP 做 CRUD，通过轮询（每 3s）获取实时状态，暂未实现 WS 订阅推送。

---

## 3. 数据流

### 持久层

| 数据 | 存储位置 | 说明 |
|------|---------|------|
| admins | SQLite `guardian.db` | SHA256 密码哈希，首次启动 seed 默认 admin/guardian2026 |
| teachers | SQLite `guardian.db` | 工号唯一，管理员创建 |
| rooms | 内存 Map | roomId → Room 对象，随进程重启丢失 |
| clients | 内存 Map + 房间内嵌 Map | clientId → ClientInfo，WS 连接对象无法序列化 |
| 违规记录 | 内存（ClientInfo.violations） | 最多保留最近 100 条，不落盘 |

### 学生上机

```
学生端                          管控服务器                    教师端
  │                                │                          │
  │  WS /guardian-ws               │                          │
  │ ──────────────────────────────►│                          │
  │◄── { welcome, clientId }       │                          │
  │                                │                          │
  │  { bind, roomCode,            │                          │
  │    studentId, name, hostname } │                          │
  │ ──────────────────────────────►│                          │
  │                                │ 验证 roomCode + studentId │
  │◄── { bind-ack, ok, roomId }    │                          │
  │                                │                          │
  │  { heartbeat } 每 5s           │  教师端轮询看到新上线      │
  │ ──────────────────────────────►│                          │
  │◄── { heartbeat-ack }           │                          │
```

### 教师远程管控

```
教师端                          管控服务器                    学生端
  │                                │                          │
  │  POST /api/rooms/:id/start     │                          │
  │ ──────────────────────────────►│                          │
  │                                │ WS { toggle-guard,      │
  │                                │      enabled: true }     │
  │                                │ ───────────────────────►│
  │                                │                main.js: 启动守卫
  │◄── { ok: true, sent: N }       │                          │
```

### 违规检测

```
学生端 main.js                     管控服务器                   教师端
  │                                │                          │
  │  PowerShell 扫描进程            │                          │
  │  白名单比对 → 违规               │                          │
  │                                │                          │
  │  WS { violations: [...] }      │                          │
  │ ──────────────────────────────►│                          │
  │                                │ 附加到 client.violations  │
  │                                │ 保留最近 100 条           │
  │                                │                          │
  │                                │  教师端轮询拉取           │
  │                                │ ◄─────────────────────── │
```

---

## 4. REST API 路径表

| 方法 | 路径 | 认证 | 角色 | 说明 |
|------|------|------|------|------|
| POST | `/api/admin/login` | 否 | — | 管理员登录 |
| GET | `/api/admin/teachers` | admin | admin | 教师列表 |
| POST | `/api/admin/teachers` | admin | admin | 创建教师 |
| GET | `/api/admin/teachers/:id` | admin | admin | 教师详情 |
| PUT | `/api/admin/teachers/:id` | admin | admin | 更新教师 |
| DELETE | `/api/admin/teachers/:id` | admin | admin | 删除教师 |
| GET | `/api/admin/rooms` | admin | admin | 全局房间列表 |
| GET | `/api/admin/rooms/:id` | admin | admin | 任意房间详情 |
| DELETE | `/api/admin/rooms/:id` | admin | admin | 删除任意房间 |
| POST | `/api/teacher/login` | 否 | — | 教师登录 |
| PUT | `/api/teacher/password` | teacher | teacher | 修改密码 |
| GET | `/api/rooms` | teacher | teacher | 我的房间列表 |
| POST | `/api/rooms` | teacher | teacher | 创建房间 |
| GET | `/api/rooms/:id` | teacher | teacher | 房间详情 |
| PUT | `/api/rooms/:id` | teacher | teacher | 更新房间配置 |
| DELETE | `/api/rooms/:id` | teacher | teacher | 删除房间 |
| POST | `/api/rooms/:id/start` | teacher | teacher | 启动守卫 |
| POST | `/api/rooms/:id/stop` | teacher | teacher | 停止守卫 |
| POST | `/api/rooms/:id/broadcast` | teacher | teacher | 广播消息 |
| GET | `/api/rooms/:id/students` | teacher | teacher | 学生列表 |
| POST | `/api/rooms/:id/students` | teacher | teacher | 添加学生 |
| DELETE | `/api/rooms/:id/students/:studentId` | teacher | teacher | 移除学生 |
| GET | `/api/rooms/:id/clients` | teacher | teacher | 房间内子机列表 |
| POST | `/api/rooms/:id/clients/:cid/toggle-guard` | teacher | teacher | 开关指定子机守卫 |
| POST | `/api/rooms/:id/clients/:cid/kill` | teacher | teacher | 结束指定子机进程 |
| POST | `/api/rooms/:id/clients/:cid/update-whitelist` | teacher | teacher | 下发白名单 |
| POST | `/api/student/bind` | 否 | — | HTTP 绑定（子机备用入口） |

---

## 5. WebSocket 协议（管控服务器 ↔ 学生端）

### 连接生命周期

```
WS connect /guardian-ws
  │
  ├─ 生成 clientId, 写入 clients Map
  ├─ 发送 { type: "welcome", clientId }
  └─ 启动 30s bind 超时定时器
       │
       ├─ 30s 内收到 bind
       │    ├─ 验证 roomCode → findRoomByJoinCode()
       │    ├─ 验证 studentId → findStudentInRoom()
       │    ├─ 绑定到房间 → bindClient()
       │    ├─ 清除定时器
       │    └─ 发送 { bind-ack, ok, roomId, roomName }
       │
       └─ 30s 超时 → ws.close(4000, 'bind timeout'), 清理 clients
```

### 消息类型

#### 学生机 → 管控服务器

| type | 时机 | 载荷 | 服务端响应 |
|------|------|------|-----------|
| `bind` | 连接后 30s 内 | `{ roomCode, studentId, name, hostname }` | `bind-ack` |
| `heartbeat` | 每 5s | `{ guardActive, processCount, violations[] }` | `heartbeat-ack` |
| `violation-log` | 发现违规时 | `{ violations[] }` | 无确认 |

#### 管控服务器 → 学生机

| type | 时机 | 载荷 | 说明 |
|------|------|------|------|
| `welcome` | WS 连接 | `{ clientId }` | 标识连接 |
| `bind-ack` | bind 处理完 | `{ ok, roomId, roomName }` 或 `{ ok: false, msg }` | 失败不关闭连接 |
| `heartbeat-ack` | 收到 heartbeat | `{}` | 仅确认 |
| `toggle-guard` | 教师远程开关 | `{ enabled: boolean }` | 启停守卫循环 |
| `update-whitelist` | 教师下发白名单 | `{ whitelist }` | 更新客户端白名单 |
| `force-kill-process` | 教师结束进程 | `{ pid: number }` | taskkill |
| `broadcast` | 教师发通知 | `{ message: string }` | 弹窗显示 |

### 异常处理

| 场景 | 行为 |
|------|------|
| WS 断开 | 服务端清理 clients，调用 deleteClient() |
| 服务端宕机 | 学生端自动重连，无限重试 |
| bind 失败（roomCode/studentId 无效） | 返回 `{ ok: false, msg }`，不关闭连接，允许重试 |
| 心跳超时 120s | 每 30s 扫描，pruneInactiveClients() terminate 并清理 |
| 重复 studentId 绑定 | 踢掉旧连接，新连接接管 |
