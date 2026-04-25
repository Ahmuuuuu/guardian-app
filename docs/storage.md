# 后端存储设计

---

## 数据归属

| 数据 | 存哪 | 原因 |
|------|------|------|
| **teachers** | SQLite | 账号长期有效，不能丢 |
| **rooms** | 内存 Map | 房间最多持续半天，丢了重建 |
| **students** | 内存（rooms Map 内嵌） | 随房间一起存在 |
| **clients** | 内存 Map | WebSocket 对象无法序列化 |
| **违规记录** | 内存 | 临时缓存，随房间消失 |
| **心跳时间** | 内存 | 纯实时，丢就丢了 |
| **admin 账号** | SQLite | 管理员登录，管理教师 |

服务器长期运行不重启，rooms/students/clients 全在内存里，不落盘。

---

## SQLite — admins + teachers

两张表：

```sql
CREATE TABLE admins (
  id         TEXT PRIMARY KEY,         -- "a_xxx"
  username   TEXT UNIQUE NOT NULL,     -- 登录名，默认 "admin"
  password   TEXT NOT NULL,            -- SHA256 哈希
  created_at TEXT NOT NULL             -- ISO 8601
);

CREATE TABLE teachers (
  id         TEXT PRIMARY KEY,         -- "t_xxx"
  staff_id   TEXT UNIQUE NOT NULL,     -- 工号，如 "T001"
  name       TEXT NOT NULL,            -- 姓名
  password   TEXT NOT NULL,            -- SHA256 哈希
  created_at TEXT NOT NULL             -- ISO 8601
);
```

首次启动 seed 默认管理员 `admin / guardian2026`。

原子 SQL 访问封装在 `sql/db.js`；账号业务封装在 `service/account/account-service.js`。

`sql/db.js` 暴露：

```js
function initDB()                   // 建表 + seed 默认管理员
// Admins
function getAdmin(username)         // 按用户名查
function insertAdmin(data)          // 新增管理员
// Teachers
function getTeacherByStaffId(id)    // 按工号查
function getTeacher(id)             // 按 ID 查
function listTeachers()             // 全部教师
function insertTeacher(data)        // 新增
function updateTeacher(id, data)    // 更新
function deleteTeacher(id)          // 删除
```

---

## 内存 — rooms / students / clients

业务逻辑在 `service/runtime/runtime-state-service.js`，底层 Map 容器在 `store/memory.js`。

### 顶层容器

```js
// 房间索引 — 主结构
const rooms = new Map();         // roomId → Room 对象

// 全局反查索引 — clientId → roomId
const clientRoomIndex = new Map();  // clientId → roomId
```

### Room 对象结构

Room 内部嵌套 `clients` 子 Map，学生名单直接挂在 `students` 数组上：

```js
// rooms.set(roomId, {
//   roomName, joinCode, createdAt, teacherId,
//   guard: { checkInterval, notifyOnly, autoStartGuard },
//   schedule: { autoMode, gracePeriod, allowLateJoin },
//   whitelist: { processes: [], browsers: [], urls: [] },
//   violations: { maxAllowed: 0 },
//   students: [
//     { studentId: "2024001", name: "张三" }
//   ],
//   clients: new Map()    // clientId → ClientInfo
// })
```

一个房间里的 clients 结构示意：

```
rooms Map
├─ "r_a1b2c3" → Room {
│    roomName: "301",
│    students: [ { studentId:"2024001", name:"张三" }, ... ],
│    clients: Map          ← 房间 A 的子机
│     ├─ "c_xxx1" → { studentId, name, ip, ws, guardActive, ... }
│     ├─ "c_xxx2" → { studentId, name, ip, ws, guardActive, ... }
│     └─ ...
│  }
├─ "r_d4e5f6" → Room {
│    roomName: "302",
│    students: [ ... ],
│    clients: Map          ← 房间 B 的子机
│     └─ ...
│  }
└─ ...

clientRoomIndex Map           ← 反查索引
 ├─ "c_xxx1" → "r_a1b2c3"
 ├─ "c_xxx2" → "r_a1b2c3"
 ├─ "c_xxx3" → "r_d4e5f6"
 └─ ...
```

### ClientInfo 结构

```js
{
  ws: <WebSocket>,            // WS 连接对象（必须）
  ip: "192.168.1.10",
  clientId: "c_a1b2c3",
  studentId: "2024001",
  studentName: "张三",
  hostname: "PC-01",
  lastSeen: 1745568000000,    // 最后心跳时间
  guardActive: true,
  violations: [],             // 最近违规记录
  processCount: 8,
  bindAt: 1745568000000       // 绑定时间
}
```
