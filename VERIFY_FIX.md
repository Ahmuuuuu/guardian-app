## 🧪 修复验证清单

### ✅ 步骤 1：检查修改的文件

```bash
# 验证 main.js 导入了 iconv-lite
grep "require('iconv-lite')" client/src/main.js
# 预期：const iconvLite = require('iconv-lite');

# 验证 main.js 有 safeLog 函数
grep "function safeLog" client/src/main.js
# 预期：function safeLog(prefix, ...args) {

# 验证 remote-client.js 导入了 iconv-lite
grep "require('iconv-lite')" client/src/remote-client.js
# 预期：const iconvLite = require('iconv-lite');
```

### ✅ 步骤 2：验证依赖安装

```bash
cd client
npm list iconv-lite
# 预期：iconv-lite@0.7.2 (已安装)
```

### ✅ 步骤 3：运行编码修复脚本

```bash
cd client
node fix-encoding.js
# 预期：
# ✅ config.json: 已从 utf8 转换为 UTF-8
# ✅ whitelist.json: 已从 utf8 转换为 UTF-8
```

### ✅ 步骤 4：启动应用并检查日志

```bash
cd client
npm start
```

**在 DevTools (F12) 或终端检查：**

- [ ] 没有看到 `????` 乱码
- [ ] 没有看到 `\uXXXX` 逃逸字符
- [ ] 中文消息如 `[Remote] 连接管控服务器:` 显示正常

### ✅ 步骤 5：检查文件编码

1. VS Code 打开 `client/data/config.json`
2. 右下角查看编码标签
3. 应显示：`UTF-8` （不是 GBK、GB2312、ASCII 等）

### 🎉 修复成功标志

✅ 所有上述检查都通过
✅ client 启动时没有编码相关错误
✅ 日志输出中文正常显示

---

## 如果仍有问题

### 问题 1：仍然看到乱码

```bash
# 重新运行修复脚本
cd client
rm -r node_modules
npm install
node fix-encoding.js
npm start
```

### 问题 2：PowerShell 进程列表仍然失败

检查 main.js 的 getWindowedProcesses() 函数，确认有这行：

```javascript
exec(ps, { encoding: 'binary', timeout: 5000 }, (err, stdout) => {
```

### 问题 3：控制台仍显示乱码

检查 main.js 中有这些函数定义：

```javascript
function safeLog(prefix, ...args) { ... }
function safeError(prefix, ...args) { ... }
```

并且所有的 `console.log` 都改成了 `safeLog`

---

## 📊 修复完成度

- [x] iconv-lite 已安装 (npm install iconv-lite)
- [x] main.js 已修改 (PowerShell 编码处理)
- [x] remote-client.js 已修改 (safeLog 函数)
- [x] JSON 文件已转换 (fix-encoding.js)
- [x] fix-encoding.js 脚本已创建
- [x] 修复文档已生成 (ENCODING_FIX.md)

**总体完成度：100% ✅**
