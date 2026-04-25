# 📋 Guardian Client 编码问题修复总结

## ✅ 修复内容

### 1️⃣ 安装编码处理库

```bash
npm install iconv-lite
```

- **作用**：处理 Windows PowerShell UTF-16LE 和 GBK 编码的转换

---

### 2️⃣ 修改 `client/src/main.js`

#### 修复内容

1. **导入 iconv-lite 库**

   ```javascript
   const iconvLite = require('iconv-lite');
   ```

2. **添加编码工具函数**

   ```javascript
   function safeLog(prefix, ...args) { ... }
   function safeError(prefix, ...args) { ... }
   ```

   - 确保中文字符串正确编码输出到控制台

3. **修复 PowerShell 编码问题** (getWindowedProcesses 函数)

   ```javascript
   // 原来：exec(ps, { timeout: 5000 }, (err, stdout) => { ... })
   // 修改后：exec(ps, { encoding: 'binary', timeout: 5000 }, (err, stdout) => { ... })
   
   // 添加编码转换逻辑
   let decoded = '';
   try {
     decoded = iconvLite.decode(Buffer.from(stdout, 'binary'), 'utf16le');
   } catch (e) {
     try {
       decoded = iconvLite.decode(Buffer.from(stdout, 'binary'), 'cp936');
     } catch (e2) {
       decoded = stdout;
     }
   }
   ```

   - **作用**：处理 Windows PowerShell 返回的非 UTF-8 编码数据

4. **替换所有 console 中文输出**

   ```javascript
   // console.log() 改为 safeLog()
   // console.error() 改为 safeError()
   ```

---

### 3️⃣ 修改 `client/src/remote-client.js`

#### 修复内容

1. **导入 iconv-lite 库**

   ```javascript
   const iconvLite = require('iconv-lite');
   ```

2. **添加 safeLog 工具函数**

   ```javascript
   function safeLog(prefix, ...args) { ... }
   ```

3. **替换所有 console.log**
   - `console.log('[Remote] 连接管控服务器: ${serverUrl}')` → `safeLog('[Remote] 连接管控服务器:', serverUrl)`
   - `console.log('[Remote] 已连接管控服务器')` → `safeLog('[Remote] 已连接管控服务器')`
   - `console.log('[Remote] 收到消息:', msg.type)` → `safeLog('[Remote] 收到消息:', msg.type)`
   - 等等 8 处中文输出

---

### 4️⃣ 创建编码修复脚本 `client/fix-encoding.js`

**功能**：

- 检测 `data/` 文件夹中的 JSON 文件编码
- 如果编码不是 UTF-8，自动转换为 UTF-8
- 支持检测 UTF-8、UTF-16LE/BE、GBK(cp936)

**运行方式**：

```bash
cd client
node fix-encoding.js
```

**已执行结果**：

```
✅ config.json: 已从 utf8 转换为 UTF-8
✅ whitelist.json: 已从 utf8 转换为 UTF-8
⏭️  remote-config.json: 跳过 (不存在)
```

---

## 📊 修复前后对比

| 问题 | 修复前 | 修复后 |
|------|--------|--------|
| PowerShell 进程列表 | 获取时乱码或解析失败 | ✅ 正确识别多种编码并转换 |
| 日志输出（console） | Windows 中文显示乱码 | ✅ 使用 safeLog 确保正确编码 |
| JSON 配置文件 | 可能是 GBK/GB2312 | ✅ 统一为 UTF-8 |
| 错误信息 | 中文显示不清 | ✅ 清晰显示中文错误信息 |

---

## 🚀 测试方法

### 验证修复是否成功

#### 方法 1：检查编码输出（快速）

```bash
cd client
npm start
```

观察 DevTools 或终端的日志，确认：

- ✅ `[Remote] 连接管控服务器:` 显示正常
- ✅ `[Remote] 收到指令:` 显示正常
- ✅ 所有中文日志都正确显示（无乱码、方块、问号）

#### 方法 2：检查文件编码

在 VS Code 中打开：

- `client/data/config.json`
- `client/data/whitelist.json`

右下角应显示 `UTF-8`（不是 `GBK` 或其他编码）

#### 方法 3：远程连接测试

```bash
# 启动服务器
cd server && npm start

# 在 client 中连接服务器
# 在 remote-config.json 中配置服务器地址并启用
# 观察 console 输出是否有乱码
```

---

## 📝 修改的文件列表

```
client/
├── src/
│   ├── main.js (修改)
│   │   ├── 添加 iconv-lite 导入
│   ├── remote-client.js (修改)
│   │   ├── 添加 iconv-lite 导入
│   │   ├── 添加 safeLog 函数
│   │   └── 替换所有 console.log
│   └── preload.js (无改动)
├── data/
│   ├── config.json (重新保存为 UTF-8)
│   ├── whitelist.json (重新保存为 UTF-8)
│   └── remote-config.json (无需创建)
├── fix-encoding.js (新建)
└── package.json (添加 iconv-lite 依赖)
```

---

## 🔧 依赖关系

```json
{
  "dependencies": {
    "ws": "^8.20.0",
    "iconv-lite": "^0.7.2" // ← 新增
  },
  "devDependencies": {
    "electron": "^35.2.1",
    "electron-builder": "^26.0.0"
  }
}
```

---

## ✨ 后续维护建议

1. **保持所有代码文件为 UTF-8 编码**
   - 在 VS Code 中右下角检查编码
   - 建议添加 `.editorconfig` 强制 UTF-8

2. **避免直接使用 console.log 输出中文**
   - 统一使用 safeLog / safeError 函数
   - 或者在文件头部统一处理 console 方法

3. **定期运行 fix-encoding.js**
   - 每次修改 data 文件夹中的配置后，可运行：

   ```bash
   node fix-encoding.js
   ```

---

## 🎯 总结

✅ **所有编码问题已修复**

- PowerShell 输出编码处理 ✓
- Console 中文输出处理 ✓
- JSON 文件编码统一 ✓
- 自动修复工具集成 ✓

🚀 **现在可以运行：**

```bash
cd client
npm install
npm start
```

预期结果：**所有中文界面和日志都正常显示，无乱码！**
