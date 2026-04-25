/**
 * Worker 脚本 — 每个 Worker 管理 500 个 WS 客户端
 * 由 real-world-sim.js 通过 worker_threads 派生
 */
const { parentPort, workerData } = require('worker_threads');
const { WebSocket } = require('../server/node_modules/ws');

const WORKER_ID = workerData?.workerId || '?';

let PORT;
let clients = [];
let phase = 'init';
let timers = [];
let isShuttingDown = false;

function clearTimers() {
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  timers = [];
}

function log(level, msg, data) {
  parentPort?.postMessage({ type: 'log', level, msg: `[W${WORKER_ID}] ${msg}`, data });
}

function status(type, data) {
  parentPort?.postMessage({ type: 'status', subType: type, ...data });
}

function error(msg, detail) {
  parentPort?.postMessage({ type: 'error', msg, detail: String(detail || '') });
}

function wsConnect(timeout = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/guardian-ws`);
    const buf = [];
    ws._buf = buf;
    ws.on('message', d => buf.push(d));

    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      ws.removeListener('open', onOpen);
      ws.removeListener('error', onError);
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) { try { ws.close(); } catch {} reject(err); }
      else { resolve(ws); }
    };
    const onOpen = () => finish(null);
    const onError = (err) => finish(err || new Error('ws error'));

    ws.once('open', onOpen);
    ws.once('error', onError);
    timer = setTimeout(() => finish(new Error('timeout')), timeout);
  });
}

function wsSend(ws, m) { try { ws.send(JSON.stringify(m)); } catch { return false; } return true; }

function wsWait(ws, type, ttl = 5000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`wait "${type}" failed: socket not open`));
      return;
    }

    for (let i = 0; i < ws._buf.length; i++) {
      try { const m = JSON.parse(ws._buf[i].toString()); if (m.type === type) { ws._buf.splice(i, 1); return resolve(m); } } catch {}
    }

    let settled = false;
    let timer = null;
    const cleanup = () => {
      ws.removeListener('message', onMessage);
      ws.removeListener('close', onClose);
      if (timer) { clearTimeout(timer); timer = null; }
    };
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(data);
    };

    const onMessage = d => {
      try {
        const m = JSON.parse(d.toString());
        if (m.type !== type) return;
        const idx = ws._buf.indexOf(d);
        if (idx >= 0) ws._buf.splice(idx, 1);
        finish(null, m);
      } catch {}
    };
    const onClose = () => finish(new Error(`wait "${type}" closed`));

    timer = setTimeout(() => finish(new Error(`wait "${type}" timeout`)), ttl);
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

function wsClose(ws) { try { ws.close(); } catch {} }

function markClientDisconnected(c) {
  c.connected = false; c.bound = false; c.ws = null; c.clientId = null;
}

function bindClientSocket(c, ws, clientId) {
  if (c.ws && c.ws !== ws) wsClose(c.ws);
  c.ws = ws;
  c.clientId = clientId;
  c.connected = true;
  c.bound = false;

  const onSocketDown = () => { if (c.ws === ws) markClientDisconnected(c); };
  ws.once('close', onSocketDown);
  ws.once('error', onSocketDown);
}

function getConnected() { return clients.filter(c => c.connected); }

function getStats() {
  const c = getConnected();
  const bound = c.filter(c => c.bound);
  const totalHb = clients.reduce((s, c) => s + c.hbSent, 0);
  const totalAck = clients.reduce((s, c) => s + c.hbAcked, 0);
  return { connected: c.length, bound: bound.length, total: clients.length, hbSent: totalHb, hbAcked: totalAck };
}

async function connectAll() {
  log('INFO', `开始连接 ${clients.length} 个客户端...`);
  let connected = 0, failed = 0;
  const errors = [];

  const batchSize = 50;
  for (let i = 0; i < clients.length; i += batchSize) {
    if (isShuttingDown) return;
    const batch = clients.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(async (c) => {
      try {
        const ws = await wsConnect();
        const welcome = await wsWait(ws, 'welcome');
        if (!welcome || !welcome.clientId) { wsClose(ws); return { ok: false, err: 'no-welcome' }; }
        bindClientSocket(c, ws, welcome.clientId);
        return { ok: true };
      } catch (e) { return { ok: false, err: e.message }; }
    }));

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) connected++;
      else { failed++; if (failed <= 20) errors.push(r.value?.err || 'unknown'); }
    }
  }

  if (failed > 0) {
    const retries = clients.filter(c => !c.connected);
    log('INFO', `重试 ${retries.length} 个失败连接...`);
    let retryOk = 0;
    for (let i = 0; i < retries.length; i += batchSize) {
      if (isShuttingDown) return;
      const batch = retries.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(async (c) => {
        try {
          const ws = await wsConnect(8000);
          const welcome = await wsWait(ws, 'welcome', 8000);
          if (!welcome || !welcome.clientId) { wsClose(ws); return { ok: false }; }
          bindClientSocket(c, ws, welcome.clientId);
          return { ok: true };
        } catch { return { ok: false }; }
      }));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.ok) { retryOk++; connected++; failed--; }
      }
    }
    if (retryOk > 0) log('INFO', `重连成功 ${retryOk} 个`);
  }

  let bound = 0, bindFailed = 0;
  const bindErrors = [];
  for (let i = 0; i < clients.length; i += batchSize) {
    if (isShuttingDown) return;
    const batch = clients.slice(i, i + batchSize).filter(c => c.connected);
    const results = await Promise.allSettled(batch.map(async (c) => {
      try {
        if (!wsSend(c.ws, { type: 'bind', roomCode: c.student.joinCode, studentId: c.student.studentId, name: c.student.name, hostname: `PC-${c.student.name}` })) {
          markClientDisconnected(c);
          return { ok: false, err: 'bind-send-failed' };
        }
        const ack = await wsWait(c.ws, 'bind-ack');
        if (ack && ack.ok) { c.bound = true; return { ok: true }; }
        return { ok: false, err: 'bind-nok' };
      } catch (e) {
        if (!c.ws || c.ws.readyState !== WebSocket.OPEN) markClientDisconnected(c);
        return { ok: false, err: e.message };
      }
    }));

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) bound++;
      else { bindFailed++; if (bindFailed <= 10) bindErrors.push(r.value?.err || 'unknown'); }
    }
  }

  status('connect', { connected, failed, bound, bindFailed, errors: errors.slice(0, 5), bindErrors: bindErrors.slice(0, 5) });
}

async function heartbeatAll() {
  const conn = getConnected();
  if (conn.length === 0) return { sent: 0, acked: 0 };

  let sent = 0, acked = 0;
  const promises = conn.map(async (c) => {
    try {
      wsSend(c.ws, { type: 'heartbeat', guardActive: true, processCount: Math.floor(Math.random() * 15) + 3, violations: [] });
      c.hbSent++;
      sent++;
      await wsWait(c.ws, 'heartbeat-ack', 3000);
      c.hbAcked++;
      acked++;
    } catch {}
  });
  await Promise.allSettled(promises);
  return { sent, acked };
}

async function reconnectSome(count) {
  const candidates = clients.filter(c => !c.connected);
  if (candidates.length < count) {
    const conn = clients.filter(c => c.connected);
    const toDrop = conn.sort(() => Math.random() - 0.5).slice(0, count - candidates.length);
    for (const c of toDrop) {
      wsClose(c.ws);
      markClientDisconnected(c);
    }
    candidates.push(...toDrop);
  }

  const pick = candidates.sort(() => Math.random() - 0.5).slice(0, count);
  if (pick.length === 0) return { attempted: 0, succeeded: 0 };

  let succeeded = 0;
  for (const c of pick) {
    if (isShuttingDown) break;
    try {
      const ws = await wsConnect();
      const welcome = await wsWait(ws, 'welcome');
      if (!welcome || !welcome.clientId) { wsClose(ws); continue; }
      bindClientSocket(c, ws, welcome.clientId);
      wsSend(ws, { type: 'bind', roomCode: c.student.joinCode, studentId: c.student.studentId, name: c.student.name, hostname: `PC-${c.student.name}` });
      const ack = await wsWait(ws, 'bind-ack');
      if (ack && ack.ok) { c.bound = true; succeeded++; }
      else markClientDisconnected(c);
    } catch { markClientDisconnected(c); }
  }
  return { attempted: count, succeeded };
}

function sendViolations(count) {
  const conn = getConnected().filter(c => c.bound);
  if (conn.length === 0) return 0;
  const pick = conn.sort(() => Math.random() - 0.5).slice(0, Math.min(count, conn.length));
  for (const c of pick) {
    const violations = [];
    const vcount = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < vcount; i++) {
      violations.push({
        process: ['Minesweeper.exe', 'Solitaire.exe', 'game.exe', 'steam.exe', 'wechat.exe'][Math.floor(Math.random() * 5)],
        pid: 10000 + Math.floor(Math.random() * 90000),
        title: ['游戏', '聊天', '网页'][Math.floor(Math.random() * 3)] + ' #' + (Date.now() % 1000),
        time: Date.now()
      });
    }
    wsSend(c.ws, { type: 'violation-log', violations });
  }
  return pick.length;
}

function disconnectAll() {
  let count = 0;
  for (const c of clients) {
    if (c.ws) { wsClose(c.ws); count++; }
    markClientDisconnected(c);
  }
  clearTimers();
  return count;
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'config') {
    PORT = msg.port;
    clients = msg.students.map(s => ({
      student: s,
      ws: null, clientId: null, connected: false, bound: false, hbSent: 0, hbAcked: 0
    }));
    parentPort.postMessage({ type: 'ready' });
  }

  else if (msg.type === 'phase' && msg.phase === 'connect') {
    phase = 'connect';
    const start = Date.now();
    await connectAll();
    parentPort.postMessage({ type: 'phase-done', phase: 'connect', time: Date.now() - start, stats: getStats() });
  }

  else if (msg.type === 'phase' && msg.phase === 'class') {
    phase = 'class';
    const durationMs = msg.durationMs || 7200000;
    const classStart = Date.now();
    let hbTick = 0;

    const hbTimer = setInterval(async () => {
      if (isShuttingDown) return;
      hbTick++;
      const result = await heartbeatAll();
      parentPort.postMessage({ type: 'heartbeat-report', tick: hbTick, ...result, stats: getStats() });
    }, 30000);
    timers.push(hbTimer);

    const hbFixTimer = setInterval(async () => {
      if (isShuttingDown) return;
      const result = await heartbeatAll();
      parentPort.postMessage({ type: 'heartbeat-report', tick: hbTick, ...result, stats: getStats() });
    }, 30000);
    timers.push(hbFixTimer);

    const miscTimer = setInterval(async () => {
      if (isShuttingDown) return;

      const reconnectCount = Math.floor(Math.random() * 11) + 5;
      const reconResult = await reconnectSome(reconnectCount);
      if (reconResult.succeeded > 0) {
        parentPort.postMessage({ type: 'reconnect-report', ...reconResult });
      }

      const vioCount = Math.floor(Math.random() * 21) + 10;
      const sent = sendViolations(vioCount);
      if (sent > 0) {
        parentPort.postMessage({ type: 'violation-report', sent });
      }
    }, 120000);
    timers.push(miscTimer);

    await new Promise(r => {
      const endTimer = setTimeout(r, durationMs);
      timers.push(endTimer);
    });

    clearTimers();
    parentPort.postMessage({ type: 'phase-done', phase: 'class', time: Date.now() - classStart, stats: getStats() });
  }

  else if (msg.type === 'phase' && msg.phase === 'disconnect') {
    phase = 'disconnect';
    const count = disconnectAll();
    parentPort.postMessage({ type: 'phase-done', phase: 'disconnect', disconnected: count, stats: getStats() });
  }

  else if (msg.type === 'shutdown') {
    isShuttingDown = true;
    disconnectAll();
    parentPort.postMessage({ type: 'shutdown-ack' });
  }
});
