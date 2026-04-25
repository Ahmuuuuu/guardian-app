# Guardian 技术栈方案

---

## 1. 系统规模

| 维度 | 数值 |
|------|------|
| 单教室学生数 | 70 - 100 台 |
| 教室数量 | 几十间 |
| 总并发连接 | 2,000 - 10,000 WS |
| Server 部署 | **服务器**，非教师笔记本 |
| 教师端 | 浏览器 + Electron 桌面版（HTTP + 轮询） |

---

## 2. 角色定义

```
┌──────────────────────────────────────────────────────────────┐
│                     管控服务器 (guardian-server)                 │
│                                                               │
│  HTTP Layer               WS Layer          Storage Layer     │
│  ┌──────────┐       ┌───────────────┐       ┌────────────┐   │
│  │ REST API │       │  WS Gateway   │       │  SQLite    │   │
│  │ (Express)│       │  /guardian-ws │       │  (admins + │   │
│  │          │       │               │       │   teachers)│   │
│  │ admin 认证│       │  bind / 心跳   │       │            │   │
│  │ 教师 CRUD │       │ 违规上报       │       │  In-Memory │   │
│  │ 房间 CRUD │       │ 指令下发       │       │  Map       │   │
│  │ 静态页    │       │               │       │  (rooms +  │   │
│  │          │       │               │       │   clients) │   │
│  └────┬─────┘       └──────┬────────┘       └────────────┘   │
└───────┼────────────────────┼─────────────────────────────────┘
        │ HTTP               │ WS
        │                    │
   ┌────┴────────┐    ┌──────┴──────────┐    ┌────────────────┐
   │ 教师端(浏览器)│    │ 教师端(Electron) │    │ 学生端(Electron) │
   │             │    │                 │    │                │
   │ HTTP REST   │    │ HTTP + 轮询     │    │ WS 直连         │
   │ (CRUD+轮询)  │    │ (实时监控)       │    │ (心跳+守卫循环)  │
   └─────────────┘    └─────────────────┘    └────────────────┘
```

### 角色

| 角色 | 连接方式 | 职责 |
|------|---------|------|
| **admin**（系统管理员） | HTTP | 管理教师账号，查看全局房间 |
| **teacher**（教师） | HTTP | 创建房间、管理学生和白名单、下发指令 |
| **student**（学生机） | WS | 守卫循环、心跳上报、接收指令 |

### 通信模式

```
admin ── HTTP ──→ 管控服务器 ←── HTTP (轮询) ── teacher
                        ↑
student ── WS (心跳+上报) ──┘
      └── WS (指令下发) ←──┘
```

---

## 3. 数据量 & 读写特征

### 3.1 持久层数据（SQLite）

| 数据 | 总量 | 写入频率 | 读取频率 | 一致性 |
|------|------|---------|---------|--------|
| 管理员账号 | 1 | 极低 | 低（登录） | 强一致 |
| 教师账号 | 几十 - 几百 | 极低（管理员创建） | 低（登录） | 强一致 |

### 3.2 Runtime 数据（纯内存）

| 数据 | 总量 | 写入频率 | 读取频率 |
|------|------|---------|---------|
| 房间 | 几百 - 几千 | 低（创建/更新） | 中（bind 时查） |
| 学生名单 | 几万 | 低（批量导入） | 中 |
| 在线子机 | 2,000 - 10,000 | 每 5s/heartbeat | 高（教师轮询查看） |
| 违规缓存 | 随时段波动 | 发现即写 | 中 |

### 单进程承载能力

```
- 每个 WS 连接保活 ≈ 50KB 内存
- 10,000 连接 ≈ 500MB 内存
- 心跳 5s × 10,000 ≈ 2,000 次/秒 Map 写入（V8 Map O(1)，可承受）
- Node.js 单进程 `--max-old-space-size=4096` 可跑 10k+ 连接
```

---

## 4. 存储方案

### 实际采用方案

| 组件 | 方案 | 原因 |
|------|------|------|
| 持久化（账号） | **SQLite** (better-sqlite3) | 零配置，单文件，ACID，admit/teacher 读写量低 |
| Runtime 状态 | **In-Memory Map** | 简单直接，房间/client 数据随进程生命周期 |
| WS 广播 | **Map.forEach + ws.send()** | 几千连接量级没问题，无跨进程需求 |
| 违规记录 | **内存数组保留 100 条/客户端** | 临时缓存，不落盘 |
| 进程模型 | **单进程** | 当前规模足够 |

DB 路径：`server/data/guardian.db`，首次启动自动建表 + seed 默认管理员。

### 未来扩容路径

| 阶段 | 存储变化 | 广播变化 | 进程模型 |
|------|---------|---------|---------|
| 阶段 1（当前） | SQLite + Map | forEach send | 单进程 |
| 阶段 2 | + Redis (rooms/clients) | Redis Pub/Sub | 多进程 Cluster |
| 阶段 3 | + PostgreSQL (全量) | 同上 | 多服务器 |

---

## 5. 模块结构（当前实现）

```
guardian-server/
├── src/
│   ├── server.js              # 入口：创建 HTTP + WS 服务
│   └── app.js                 # Express：挂载中间件、路由、静态文件
│
├── router/
│   ├── admin.js               # POST /api/admin/login + 教师 CRUD
│   ├── teacher.js             # POST /api/teacher/login + 密码修改
│   ├── rooms.js               # /api/rooms 房间 CRUD + 指令下发
│   └── student.js             # POST /api/student/bind
│
├── service/
│   ├── account/
│   │   └── account-service.js         # admin & teacher 账号验证/CRUD
│   ├── runtime/
│   │   └── runtime-state-service.js   # 房间/客户端状态业务：CRUD、广播、守卫启停
│   └── gateway/
│       └── ws-gateway.js              # WebSocket 接入 + 消息分发
│
├── utils/
│   ├── auth.js                # Token (HMAC-SHA256) + requireAuth/requireRole
│   └── storage.js             # (未使用，原 JSON 文件读写)
│
├── store/
│   └── memory.js              # 全局内存状态：rooms Map, clients Map, 接入码索引
│
├── sql/
│   ├── db.js                  # better-sqlite3 封装
│   ├── schema.sql             # admins + teachers 建表
│   └── seed.sql               # 默认管理员 seed
│
├── assets/
│   └── control.html           # 教师端浏览器 UI
│
├── desktop/
│   ├── main.js                # 教师端 Electron 桌面版
│   └── icon.png
│
├── data/                      # 运行时数据目录
│   └── guardian.db            # SQLite 数据库文件 (自动创建)
│
└── package.json
```

---

## 6. 教师端技术栈

教师端是**浏览器 + Electron 桌面版**双形态。

| 层面 | 方案 |
|------|------|
| UI 框架 | **原生 HTML/CSS/JS** |
| 桌面容器 | **Electron**（仅封装 browser window） |
| HTTP 请求 | **fetch** |
| 状态获取 | **轮询（每 3s）**，暂未实现 WS 推送 |
| 打包 | electron-builder |

教师端 Electron 只封装一个 browser window 加载 `http://server:3847`，不做任何业务逻辑。

---

## 7. 认证体系

| 机制 | 实现 |
|------|------|
| Token 格式 | HMAC-SHA256(base64url(JSON payload) + 签名) |
| 传输方式 | Header `x-token` |
| 载荷 | `{ role, username/teacherId, staffId, iat }` |
| 验证 | 服务端 `verifyToken()` 验签 + `requireRole()` 检查角色 |
| 密码存储 | SHA256 哈希（无 salt，当前阶段使用） |

### 路由保护模式

```js
router.post('/login', ...)                    // 公开
router.use(...requireAdmin)                   // 以下全部需 admin 角色
// 或
router.use(...requireTeacher)                 // 以下全部需 teacher 角色
```

---

## 8. 命名规范

| 目录/文件 | 说明 |
|-----------|------|
| `client/` | 学生端 Electron 应用 |
| `server/` | 管控服务器 |
| `server/assets/` | 教师端 Web UI 静态文件 |
| `server/desktop/` | 教师端 Electron 桌面版 |
| `server/router/` | Express 路由（按业务角色拆分） |
| `server/service/` | 业务逻辑层 |
| `server/store/` | 数据访问层（内存 Map） |
| `server/sql/` | SQLite 数据库层 |
| `server/utils/` | 工具（认证、存储辅助） |
