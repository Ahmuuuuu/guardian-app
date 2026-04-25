/**
 * Guardian 真实运行模拟 — 主编排器
 *
 * 模拟多教师多班级全天教学场景，覆盖所有功能点，
 * 含高压并发，使用 worker_threads 并行管理 5000 WS 连接。
 *
 * 运行: node test/real-world-sim.js
 * 日志: log/sim-<时间戳>.log
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');

// ── 日志 ──
const LOG_DIR = path.join(__dirname, '..', 'log');
fs.mkdirSync(LOG_DIR, { recursive: true });
const START_TIME = new Date();
const TS_FILE = START_TIME.toISOString().replace(/[:.]/g, '-');
const LOG_PATH = path.join(LOG_DIR, `sim-${TS_FILE}.log`);
const LOG_STREAM = fs.createWriteStream(LOG_PATH, { flags: 'a', encoding: 'utf-8' });

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', MAGENTA = '\x1b[35m', GRAY = '\x1b[2m', RESET = '\x1b[0m';

// ── 配置 ──
const CFG = {
  TEACHER_COUNT: 10,
  ROOMS_PER_TEACHER: 5,
  STUDENTS_PER_ROOM: 100,
  WORKER_COUNT: 10,
  CLASS_DURATION_MS: 2 * 60 * 60 * 1000,
  WORKER_TIMEOUT: 3 * 60 * 60 * 1000,
};

const totalStudents = CFG.TEACHER_COUNT * CFG.ROOMS_PER_TEACHER * CFG.STUDENTS_PER_ROOM;
let PORT, adminToken, loopCount = 0;
let isStopping = false;

function ts() { return new Date().toISOString(); }
function log(level, label, msg) {
  const line = `[${ts()}] [${level}] [${label}] ${msg}`;
  LOG_STREAM.write(line + '\n');
}
function info(label, msg) { log('INFO', label, msg); console.log(`  ${CYAN}→${RESET} ${label}: ${msg}`); }
function ok(label, msg) { log('OK', label, msg); console.log(`  ${GREEN}✓${RESET} ${label}: ${msg}`); }
function fail(label, msg) { log('FAIL', label, msg); console.log(`  ${RED}✗${RESET} ${label}: ${RED}${msg}${RESET}`); }
function warn(label, msg) { log('WARN', label, msg); console.log(`  ${YELLOW}⚠${RESET} ${label}: ${msg}`); }
function phase(n, title) {
  const sep = '═'.repeat(58);
  console.log(`\n${MAGENTA}${sep}${RESET}\n${MAGENTA}  第 ${n} 阶段：${title}  [循环 #${loopCount}]${RESET}\n${MAGENTA}${sep}${RESET}`);
  LOG_STREAM.write(`\n${sep}\n  阶段 ${n}: ${title}  [循环 #${loopCount}]\n${sep}\n`);
}

function req(method, path, body, token, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: PORT, path, method, headers: {}, timeout };
    if (body) opts.headers['Content-Type'] = 'application/json';
    if (token) opts.headers['X-Token'] = token;
    const h = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    h.on('error', reject);
    h.on('timeout', () => { h.destroy(); reject(new Error('timeout')); });
    if (body) h.write(JSON.stringify(body));
    h.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

process.on('SIGINT', async () => {
  console.log(`\n${YELLOW}⚠${RESET} 收到 SIGINT，正在优雅退出...`);
  isStopping = true;
  LOG_STREAM.write('\n[SIGINT] 收到终止信号，正在退出...\n');
  await sleep(2000);
  LOG_STREAM.end();
  process.exit(0);
});
process.on('SIGTERM', () => { isStopping = true; });

// ═══════════════════════════════════════════════════
//  Worker 管理
// ═══════════════════════════════════════════════════
function spawnWorkers(studentChunks) {
  const workers = [];
  for (let i = 0; i < CFG.WORKER_COUNT; i++) {
    const w = new Worker(path.join(__dirname, 'real-world-sim-worker.js'), { workerData: { workerId: i + 1 } });
    w._idx = i;
    w._alive = true;
    w._students = studentChunks[i] || [];

    w.on('error', err => {
      w._alive = false;
      warn(`Worker ${i+1}`, `异常退出: ${err.message}`);
    });
    w.on('exit', code => {
      if (code !== 0) w._alive = false;
    });

    w.on('message', msg => {
      if (msg && msg.stats && typeof msg.stats === 'object') {
        setWorkerLiveStats(w._idx, msg.stats);
      }
      if (msg.type === 'heartbeat-report') {
        totalHbSent += msg.sent || 0;
        totalHbAcked += msg.acked || 0;
      } else if (msg.type === 'reconnect-report') {
        totalReconn += msg.succeeded || 0;
      } else if (msg.type === 'violation-report') {
        totalViolations += msg.sent || 0;
      } else if (msg.type === 'log') {
        log(msg.level || 'INFO', msg.msg || `Worker ${i+1}`, msg.data || '');
      } else if (msg.type === 'error') {
        fail(`Worker ${i+1}`, msg.msg || '未知错误');
      } else if (msg.type === 'status') {
        if (msg.subType === 'connect') {
          wsConnectedTotal += msg.connected || 0;
          wsBoundTotal += msg.bound || 0;
          wsConnectFailedTotal += msg.failed || 0;
          wsBindFailedTotal += msg.bindFailed || 0;
        }
      }
    });
    workers.push(w);
  }
  return workers;
}

function broadcastAndWait(workers, msg, phaseName, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (workers.length === 0) return resolve([]);
    const results = [];
    const remaining = new Map();
    workers.forEach(w => remaining.set(w._idx, w));

    const onMsg = (w, m) => {
      if (m.type === 'phase-done' && m.phase === phaseName) {
        results.push(m);
        remaining.delete(w._idx);
        if (remaining.size === 0) {
          cleanup();
          resolve(results);
        }
      }
    };
    const cleanup = () => workers.forEach(w => w.removeListener('message', onMsg));
    workers.forEach(w => w.on('message', msg => onMsg(w, msg)));
    workers.forEach(w => w.postMessage(msg));

    setTimeout(() => {
      cleanup();
      if (remaining.size > 0) {
        const stuck = [...remaining.keys()].map(i => `Worker ${i+1}`).join(', ');
        reject(new Error(`等待阶段 "${phaseName}" 超时: ${stuck}`));
      } else resolve(results);
    }, timeoutMs);
  });
}

function terminateWorkers(workers) {
  return Promise.allSettled(workers.map(w => {
    try {
      w.postMessage({ type: 'shutdown' });
      return new Promise(r => {
        setTimeout(() => { try { w.terminate(); } catch {} r(); }, 2000);
      });
    } catch { return Promise.resolve(); }
  }));
}

let totalHbSent = 0, totalHbAcked = 0, totalReconn = 0, totalViolations = 0;
let wsConnectedTotal = 0, wsBoundTotal = 0, wsConnectFailedTotal = 0, wsBindFailedTotal = 0;
let liveConnected = 0, liveBound = 0, liveTotal = 0;
const workerLiveStats = new Map();

function recomputeLiveStats() {
  let connected = 0;
  let bound = 0;
  let total = 0;
  for (const s of workerLiveStats.values()) {
    connected += s.connected;
    bound += s.bound;
    total += s.total;
  }
  liveConnected = connected;
  liveBound = bound;
  liveTotal = total;
}

function setWorkerLiveStats(workerIdx, stats = {}) {
  workerLiveStats.set(workerIdx, {
    connected: Number(stats.connected) || 0,
    bound: Number(stats.bound) || 0,
    total: Number(stats.total) || 0
  });
  recomputeLiveStats();
}

function resetStats() {
  totalHbSent = 0; totalHbAcked = 0; totalReconn = 0; totalViolations = 0;
  wsConnectedTotal = 0; wsBoundTotal = 0; wsConnectFailedTotal = 0; wsBindFailedTotal = 0;
  liveConnected = 0; liveBound = 0; liveTotal = 0;
  workerLiveStats.clear();
}

// ═══════════════════════════════════════════════════
//  创建环境 (教师 + 教室 + 学生)
// ═══════════════════════════════════════════════════
async function setupEnvironment() {
  phase(1, '创建环境');
  const start = Date.now();
  const teachers = [];

  let r = await req('POST', '/api/admin/login', { username: 'admin', password: 'guardian2026' });
  if (r.status !== 200) throw new Error(`管理员登录失败: ${r.status}`);
  adminToken = r.body.token;
  ok('管理员登录', '成功');

  for (let i = 0; i < CFG.TEACHER_COUNT; i++) {
    if (isStopping) return null;
    const staffId = `T_${TS_FILE}_${i}`;
    r = await req('POST', '/api/admin/teachers', { staffId, name: '教师' + (i + 1), password: 'tch123' }, adminToken);
    if (r.status !== 200) { warn('创建教师', `教师 ${i+1} 失败: ${r.status}`); continue; }
    teachers.push({ ...r.body.teacher, staffId, token: null, rooms: [] });
  }
  ok('教师创建', `${teachers.length}/${CFG.TEACHER_COUNT} 成功`);

  for (const t of teachers) {
    r = await req('POST', '/api/teacher/login', { staffId: t.staffId, password: 'tch123' });
    if (r.status === 200) t.token = r.body.token;
  }
  const validTeachers = teachers.filter(t => t.token);
  ok('教师登录', `${validTeachers.length}/${teachers.length} 成功`);

  const rooms = [];
  for (const t of validTeachers) {
    for (let j = 0; j < CFG.ROOMS_PER_TEACHER; j++) {
      r = await req('POST', '/api/rooms', { roomName: `${t.name}·${j+1}号机房` }, t.token);
      if (r.status !== 200) { warn('创建教室', `${t.name} 教室 ${j+1} 失败`); continue; }
      const room = r.body.room;
      t.rooms.push(room);
      rooms.push(room);
    }
  }
  ok('教室创建', `${rooms.length}/${CFG.TEACHER_COUNT * CFG.ROOMS_PER_TEACHER} 成功`);

  const students = [];
  for (const room of rooms) {
    const owner = validTeachers.find(t => t.rooms.some(r => r.id === room.id));
    if (!owner) continue;
    for (let k = 0; k < CFG.STUDENTS_PER_ROOM; k++) {
      const sid = `S_${room.id}_${k}`;
      const name = `${owner.name}班${rooms.indexOf(room)+1}室-${k+1}号`;
      r = await req('POST', `/api/rooms/${room.id}/students`, { studentId: sid, name }, owner.token);
      if (r.status === 200) students.push({ studentId: sid, name, roomId: room.id, joinCode: room.joinCode });
    }
  }
  ok('学生添加', `${students.length}/${totalStudents} 成功 | 耗时 ${((Date.now()-start)/1000).toFixed(1)}s`);

  return { teachers: validTeachers, rooms, students };
}

// ═══════════════════════════════════════════════════
//  课堂指令调度
// ═══════════════════════════════════════════════════
async function runTeacherSchedule(teachers, rooms) {
  const start = Date.now();
  const elapsed = () => Date.now() - start;

  async function getOnlineClients() {
    const all = [];
    for (const room of rooms) {
      const owner = teachers.find(t => t.rooms.some(r => r.id === room.id));
      if (!owner) continue;
      try {
        const r = await req('GET', `/api/rooms/${room.id}/clients`, null, owner.token, 5000);
        if (r.status === 200 && Array.isArray(r.body.clients)) {
          all.push(...r.body.clients.filter(c => c.online).map(c => ({ ...c, roomId: room.id, token: owner.token })));
        }
      } catch {}
    }
    return all;
  }

  async function broadcastAll(message) {
    let total = 0, okRooms = 0;
    for (const room of rooms) {
      const owner = teachers.find(t => t.rooms.some(r => r.id === room.id));
      if (!owner) continue;
      try {
        const r = await req('POST', `/api/rooms/${room.id}/broadcast`, { message }, owner.token, 5000);
        if (r.status === 200) { total += r.body.sent || 0; okRooms++; }
      } catch {}
    }
    return { sent: total, rooms: okRooms };
  }

  const schedule = [
    { delay: 0, label: 'START', action: async () => {
      let started = 0;
      for (const room of rooms) {
        const owner = teachers.find(t => t.rooms.some(r => r.id === room.id));
        if (!owner) continue;
        try { const r = await req('POST', `/api/rooms/${room.id}/start`, null, owner.token, 5000); if (r.status === 200) started++; } catch {}
      }
      ok('守卫启动', `${started}/${rooms.length} 房间已启动`);
    }},
    { delay: 5 * 60 * 1000, label: 'BROADCAST', action: async () => {
      const result = await broadcastAll('同学们好，现在开始上课。请关闭与课堂无关的软件，专注于学习任务。');
      ok('广播(开始)', `推送至 ${result.rooms} 个房间, ${result.sent} 台子机`);
    }},
    { delay: 15 * 60 * 1000, label: 'BROADCAST', action: async () => {
      const result = await broadcastAll('请注意：禁止在机房玩游戏、浏览无关网页。一经发现将记录违规。');
      ok('广播(提醒)', `推送至 ${result.rooms} 个房间, ${result.sent} 台子机`);
    }},
    { delay: 30 * 60 * 1000, label: 'KILL', action: async () => {
      const clients = await getOnlineClients();
      const targets = clients.sort(() => Math.random() - 0.5).slice(0, 5);
      let killed = 0;
      for (const c of targets) {
        try {
          const r = await req('POST', `/api/rooms/${c.roomId}/clients/${c.clientId}/kill`, { pid: 9999 }, c.token, 5000);
          if (r.status === 200) killed++;
        } catch {}
      }
      ok('远程杀进程', `尝试杀 ${targets.length} 个进程, 成功 ${killed}`);
    }},
    { delay: 45 * 60 * 1000, label: 'TOGGLE', action: async () => {
      const clients = await getOnlineClients();
      const targets = clients.sort(() => Math.random() - 0.5).slice(0, 5);
      let toggled = 0;
      for (const c of targets) {
        try {
          const r = await req('POST', `/api/rooms/${c.roomId}/clients/${c.clientId}/toggle-guard`, { enabled: false }, c.token, 5000);
          if (r.status === 200) toggled++;
        } catch {}
      }
      ok('远程禁守卫', `尝试禁 ${targets.length} 个, 成功 ${toggled}`);
      setTimeout(async () => {
        let restored = 0;
        for (const c of targets.slice(0, toggled)) {
          try {
            const r = await req('POST', `/api/rooms/${c.roomId}/clients/${c.clientId}/toggle-guard`, { enabled: true }, c.token, 5000);
            if (r.status === 200) restored++;
          } catch {}
        }
        if (restored > 0) ok('远程启守卫', `${restored} 个已恢复`);
      }, 120000);
    }},
    { delay: 60 * 60 * 1000, label: 'BROADCAST', action: async () => {
      const result = await broadcastAll('课堂时间已过半，请抓紧时间完成课堂作业。如有问题请举手示意。');
      ok('广播(半场)', `推送至 ${result.rooms} 个房间, ${result.sent} 台子机`);
    }},
    { delay: 80 * 60 * 1000, label: 'WHITELIST', action: async () => {
      const clients = await getOnlineClients();
      const targets = clients.sort(() => Math.random() - 0.5).slice(0, 3);
      let updated = 0;
      for (const c of targets) {
        try {
          const r = await req('POST', `/api/rooms/${c.roomId}/clients/${c.clientId}/update-whitelist`,
            { whitelist: { processes: ['studio.exe', 'code.exe', 'explorer.exe'], browsers: ['chrome.exe', 'msedge.exe'], urls: ['example.com'] } }, c.token, 5000);
          if (r.status === 200) updated++;
        } catch {}
      }
      ok('远程白名单', `更新 ${updated}/${targets.length} 个客户端`);
      const result = await broadcastAll('已更新部分同学的白名单配置，允许使用编程工具。');
      ok('广播(白名单)', `推送至 ${result.rooms} 个房间, ${result.sent} 台子机`);
    }},
    { delay: 100 * 60 * 1000, label: 'BROADCAST', action: async () => {
      const result = await broadcastAll('距离下课还有 10 分钟，请保存所有文件并关闭编辑器。');
      ok('广播(下课提醒)', `推送至 ${result.rooms} 个房间, ${result.sent} 台子机`);
    }},
    { delay: 110 * 60 * 1000, label: 'STOP', action: async () => {
      let stopped = 0;
      for (const room of rooms) {
        const owner = teachers.find(t => t.rooms.some(r => r.id === room.id));
        if (!owner) continue;
        try { const r = await req('POST', `/api/rooms/${room.id}/stop`, null, owner.token, 5000); if (r.status === 200) stopped++; } catch {}
      }
      ok('守卫停止', `${stopped}/${rooms.length} 房间已停止`);
    }},
  ];

  for (const item of schedule) {
    if (isStopping) return;
    const wait = item.delay - elapsed();
    if (wait > 0) await sleep(wait);
    if (isStopping) return;
    try { await item.action(); } catch (e) { warn(`调度[${item.label}]`, `执行异常: ${e.message}`); }
  }
  info('课堂指令', `所有定时指令执行完毕, 总计 ${((Date.now()-start)/1000).toFixed(0)}s`);
}

// ═══════════════════════════════════════════════════
//  清理
// ═══════════════════════════════════════════════════
async function cleanup(teachers, rooms) {
  phase(7, '清理');
  const start = Date.now();

  let roomsDel = 0;
  for (const room of rooms) {
    const owner = teachers.find(t => t.rooms.some(r => r.id === room.id));
    if (!owner) continue;
    try {
      const r = await req('DELETE', `/api/rooms/${room.id}`, null, owner.token, 5000);
      if (r.status === 200) roomsDel++;
      else if (r.status === 404) roomsDel++;
    } catch {}
  }
  ok('删除房间', `${roomsDel}/${rooms.length}`);

  await sleep(2000);

  let tDel = 0;
  for (const t of teachers) {
    try {
      const r = await req('DELETE', `/api/admin/teachers/${t.id}`, null, adminToken, 5000);
      if (r.status === 200) tDel++;
      else if (r.status === 400) {
        await sleep(1000);
        try { const r2 = await req('DELETE', `/api/admin/teachers/${t.id}`, null, adminToken, 5000); if (r2.status === 200) tDel++; } catch {}
      }
    } catch {}
  }
  ok('删除教师', `${tDel}/${teachers.length} | 耗时 ${((Date.now()-start)/1000).toFixed(1)}s`);
}

// ═══════════════════════════════════════════════════
//  单循环
// ═══════════════════════════════════════════════════
async function runLoop() {
  loopCount++;
  const loopStart = Date.now();
  resetStats();

  console.log(`\n${GREEN}${'═'.repeat(60)}${RESET}`);
  console.log(`${GREEN}  循环 #${loopCount}  开始于 ${new Date().toISOString()}${RESET}`);
  console.log(`${GREEN}${'═'.repeat(60)}${RESET}`);

  let teachers, rooms, students;

  try {
    const env = await setupEnvironment();
    if (!env || isStopping) return;
    teachers = env.teachers;
    rooms = env.rooms;
    students = env.students;

    if (students.length < 100) {
      warn('环境创建', `学生数不足 (${students.length}), 跳过本轮`);
      await cleanup(teachers || [], rooms || []);
      return;
    }

    phase(2, `启动 Worker (${CFG.WORKER_COUNT} 个)`);
    const chunkSize = Math.ceil(students.length / CFG.WORKER_COUNT);
    const chunks = [];
    for (let i = 0; i < CFG.WORKER_COUNT; i++) {
      chunks.push(students.slice(i * chunkSize, (i + 1) * chunkSize));
    }

    const workers = spawnWorkers(chunks);

    for (let i = 0; i < workers.length; i++) {
      workers[i].postMessage({ type: 'config', port: PORT, students: chunks[i] });
    }
    await Promise.all(workers.map(w => new Promise((resolve, reject) => {
      const handler = (msg) => { if (msg.type === 'ready') { w.removeListener('message', handler); resolve(); }};
      w.on('message', handler);
      setTimeout(() => { w.removeListener('message', handler); reject(new Error('ready timeout')); }, 15000);
    })));
    ok('Worker 就绪', `${workers.length} 个 worker 已加载 ${students.length} 名学生配置`);

    phase(3, 'WS 连接与绑定');
    await broadcastAndWait(workers, { type: 'phase', phase: 'connect' }, 'connect', 120000);
    ok('WS 连接', `连接成功 ${wsConnectedTotal}, 连接失败 ${wsConnectFailedTotal}, 绑定成功 ${wsBoundTotal}, 绑定失败 ${wsBindFailedTotal}`);

    try {
      const r = await req('GET', '/api/admin/rooms', null, adminToken, 5000);
      if (r.status === 200) {
        const online = r.body.rooms.reduce((s, rm) => s + (rm.onlineCount || 0), 0);
        ok('管理员验证', `共计 ${r.body.rooms.length} 房间, 在线 ${online} 台`);
      }
    } catch {}

    phase(4, `课堂模拟 (${CFG.CLASS_DURATION_MS / 60000} 分钟)`);
    info('课堂', `开始 2 小时实时课堂模拟...`);

    const statusInterval = setInterval(() => {
      const hbRate = totalHbSent > 0 ? ((totalHbAcked / totalHbSent) * 100).toFixed(1) : '0.0';
      const onlineConnected = liveTotal > 0 ? liveConnected : wsConnectedTotal;
      const onlineBound = liveTotal > 0 ? liveBound : wsBoundTotal;
      const onlineTotal = liveTotal > 0 ? liveTotal : (wsConnectedTotal + wsConnectFailedTotal);
      info('状态',
        `在线 ${onlineConnected}/${onlineTotal} (绑定 ${onlineBound}) | 初连 连成 ${wsConnectedTotal} 连败 ${wsConnectFailedTotal} 绑成 ${wsBoundTotal} 绑败 ${wsBindFailedTotal} | 心跳 ${totalHbSent}/${totalHbAcked} (${hbRate}%)` +
        ` | 重连 ${totalReconn} | 违规 ${totalViolations} | 运行 ${Math.floor((Date.now() - loopStart) / 60000)}min`
      );
    }, 30000);

    const classPromise = broadcastAndWait(workers,
      { type: 'phase', phase: 'class', durationMs: CFG.CLASS_DURATION_MS },
      'class', CFG.WORKER_TIMEOUT
    );
    const teacherPromise = runTeacherSchedule(teachers, rooms);

    await Promise.all([classPromise, teacherPromise]);
    clearInterval(statusInterval);
    ok('课堂结束', `心跳 ${totalHbSent} 次 (ack ${totalHbAcked}), 重连 ${totalReconn} 次, 违规 ${totalViolations} 条`);

    phase(5, '断开连接');
    await broadcastAndWait(workers, { type: 'phase', phase: 'disconnect' }, 'disconnect', 30000);
    ok('断开', '所有 WS 客户端已断开');

    await terminateWorkers(workers);
    ok('Worker 终止', `${workers.length} 个已释放`);

    await cleanup(teachers, rooms);

  } catch (e) {
    fail('循环异常', `${e.message}\n${e.stack}`);
    if (teachers) await cleanup(teachers, rooms || []);
  }

  const elapsed = ((Date.now() - loopStart) / 1000).toFixed(0);
  const elapsedMin = (elapsed / 60).toFixed(1);
  console.log(`\n${GREEN}${'─'.repeat(60)}${RESET}`);
  console.log(`${GREEN}  循环 #${loopCount} 完成 | 耗时 ${elapsed}s (${elapsedMin}min)${RESET}`);
  console.log(`${GREEN}  WS: 连成${wsConnectedTotal} 连败${wsConnectFailedTotal} 绑成${wsBoundTotal} 绑败${wsBindFailedTotal} | 心跳 ${totalHbSent}/${totalHbAcked} | 重连 ${totalReconn} | 违规 ${totalViolations}${RESET}`);
  console.log(`${GREEN}${'─'.repeat(60)}${RESET}\n`);

  LOG_STREAM.write(`\n--- 循环 #${loopCount} 摘要: 耗时 ${elapsed}s | WS 连成${wsConnectedTotal} 连败${wsConnectFailedTotal} 绑成${wsBoundTotal} 绑败${wsBindFailedTotal} | HB ${totalHbSent}/${totalHbAcked} | 重连 ${totalReconn} | 违规 ${totalViolations}\n\n`);
}

// ═══════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════
async function main() {
  LOG_STREAM.write(`Guardian 真实运行模拟\n启动时间: ${START_TIME.toISOString()}\n主机: ${os.hostname()} ${os.platform()} ${os.release()}\n配置: ${CFG.TEACHER_COUNT}教师×${CFG.ROOMS_PER_TEACHER}教室×${CFG.STUDENTS_PER_ROOM}学生 = ${totalStudents}总连接\nWorker: ${CFG.WORKER_COUNT}个 × ${totalStudents/CFG.WORKER_COUNT}连接/个 | 课堂时长: ${CFG.CLASS_DURATION_MS/60000}min\n\n`);

  require('../server/service/account/account-service').init();
  const httpServer = http.createServer(require('../server/src/app'));
  require('../server/service/gateway/ws-gateway').setupWebSocket(httpServer);
  await new Promise(r => httpServer.listen(3847, 1024, () => { PORT = 3847; r(); }));
  console.log(`${GREEN}✓${RESET} 服务端启动 on :${PORT}  |  PID ${process.pid}\n`);

  while (!isStopping) {
    const loopStart = Date.now();
    await runLoop();
    if (isStopping) break;

    const loopElapsed = Date.now() - loopStart;
    info('循环', `本轮耗时 ${(loopElapsed/1000).toFixed(0)}s (${(loopElapsed/60000).toFixed(1)}min)`);
    LOG_STREAM.write(`\n--- 循环 #${loopCount} 完成, 耗时 ${(loopElapsed/1000).toFixed(0)}s\n`);
  }

  LOG_STREAM.write(`\n模拟结束: ${new Date().toISOString()}\n共执行 ${loopCount} 个循环\n`);
  LOG_STREAM.end();
  httpServer.close(() => process.exit(0));
}

main().catch(err => {
  console.error(`\n${RED}FATAL${RESET}`, err);
  LOG_STREAM.write(`\nFATAL: ${err.stack}\n`);
  LOG_STREAM.end();
  process.exit(1);
});
