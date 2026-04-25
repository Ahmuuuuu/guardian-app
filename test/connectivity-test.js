const http = require('http');
const { WebSocket } = require('../server/node_modules/ws');

// ── Colors ──
const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', GRAY = '\x1b[2m', RESET = '\x1b[0m';

// ── Stats ──
let passed = 0, failed = 0;

function debug(msg) { console.log(`  ${CYAN}::${RESET} ${msg}`); }

function suite(name, fn) {
  console.log(`\n${YELLOW}▶ ${name}${RESET}`);
  return fn();
}

function check(okMsg, cond, errMsg) {
  if (cond) { passed++; console.log(`  ${GREEN}✓${RESET} ${okMsg}`); }
  else { failed++; console.log(`  ${RED}✗${RESET} ${okMsg}${RED} — ${errMsg}${RESET}`); }
}

// ── HTTP helper ──
let PORT;
function req(method, path, body, token) {
  return new Promise((resolve) => {
    const opts = { hostname: '127.0.0.1', port: PORT, path, method, headers: {} };
    if (body) opts.headers['Content-Type'] = 'application/json';
    if (token) opts.headers['X-Token'] = token;
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let b;
        try { b = JSON.parse(data); } catch { b = data; }
        resolve({ status: res.statusCode, body: b });
      });
    });
    r.on('error', e => resolve({ error: e.message }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// ── WebSocket helper ──
function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/guardian-ws`);
    const buf = [];
    ws.on('message', data => buf.push(data));
    ws.on('open', () => { ws._buf = buf; resolve(ws); });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 3000);
  });
}

function wsSend(ws, msg) { ws.send(JSON.stringify(msg)); }

function wsWait(ws, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    for (let i = 0; i < ws._buf.length; i++) {
      try {
        const m = JSON.parse(ws._buf[i].toString());
        if (m.type === type) { ws._buf.splice(i, 1); return resolve(m); }
      } catch {}
    }
    const t = setTimeout(() => reject(new Error(`WS wait "${type}" timeout`)), timeout);
    function handler(data) {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === type) { clearTimeout(t); resolve(m); }
    }
    ws.on('message', handler);
  });
}

// ══════════════════════════════════════════
//  Main
// ══════════════════════════════════════════
async function main() {
  // Init account (creates DB + default admin if needed)
  require('../server/service/account/account-service').init();

  const httpServer = http.createServer(require('../server/src/app'));
  require('../server/service/gateway/ws-gateway').setupWebSocket(httpServer);

  await new Promise(resolve => httpServer.listen(0, 1024, () => {
    PORT = httpServer.address().port;
    console.log(`${GREEN}✓${RESET} Server started on :${PORT}\n${GRAY}${'─'.repeat(50)}${RESET}`);
    resolve();
  }));

  let adminToken, teacherToken, teacherId, roomId, joinCode, studentId, clientId, ws;

  // ──────────────────────────────────────────
  //  Admin — Login
  // ──────────────────────────────────────────
  await suite('Admin /api/admin', async () => {
    let r = await req('POST', '/api/admin/login', { username: 'admin', password: 'guardian2026' });
    check('POST /login correct → 200 + token', r.status === 200 && r.body.ok && r.body.token,
      r.status + ' ' + JSON.stringify(r.body));
    adminToken = r.body.token;

    r = await req('POST', '/api/admin/login', { username: 'admin', password: 'wrong' });
    check('POST /login bad password → 401', r.status === 401,
      r.status + ' ' + JSON.stringify(r.body));
  });

  // ──────────────────────────────────────────
  //  Admin — Teacher CRUD
  // ──────────────────────────────────────────
  await suite('Admin /api/admin/teachers', async () => {
    const uniqueStaffId = `T${Date.now()}`;
    let r = await req('POST', '/api/admin/teachers', { staffId: uniqueStaffId, name: '测试教师', password: '123456' }, adminToken);
    check('POST /teachers create → 200', r.status === 200 && r.body.ok && r.body.teacher.staffId === uniqueStaffId,
      r.status + ' ' + JSON.stringify(r.body));
    teacherId = r.body.teacher.id;

    r = await req('POST', '/api/admin/teachers', { staffId: uniqueStaffId, name: '重复', password: '123456' }, adminToken);
    check('POST /teachers duplicate → 400', r.status === 400,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('GET', '/api/admin/teachers', null, adminToken);
    check('GET /teachers list → contains new', r.status === 200 && r.body.teachers.some(t => t.id === teacherId),
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('GET', `/api/admin/teachers/${teacherId}`, null, adminToken);
    check('GET /teachers/:id → found', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('GET', '/api/admin/teachers/nonexistent', null, adminToken);
    check('GET /teachers/:id not found → 404', r.status === 404,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('PUT', `/api/admin/teachers/${teacherId}`, { name: '改名教师' }, adminToken);
    check('PUT /teachers/:id → name updated', r.status === 200 && r.body.teacher.name === '改名教师',
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('GET', '/api/admin/teachers', null);
    check('GET /teachers no token → 401', r.status === 401,
      r.status + ' ' + JSON.stringify(r.body));
  });

  // ──────────────────────────────────────────
  //  Teacher — Login
  // ──────────────────────────────────────────
  await suite('Teacher /api/teacher', async () => {
    let r = await req('POST', '/api/teacher/login', { staffId: 'nonexistent', password: '123456' });
    check('POST /login unknown staffId → 401', r.status === 401,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('POST', '/api/teacher/login', { staffId: (await (await req('GET', `/api/admin/teachers/${teacherId}`, null, adminToken)).body).teacher.staffId, password: '123456' });
    check('POST /login correct → 200 + token', r.status === 200 && r.body.ok && r.body.token,
      r.status + ' ' + JSON.stringify(r.body));
    teacherToken = r.body.token;

    r = await req('POST', '/api/teacher/login', { staffId: (await (await req('GET', `/api/admin/teachers/${teacherId}`, null, adminToken)).body).teacher.staffId, password: 'wrong' });
    check('POST /login wrong password → 401', r.status === 401,
      r.status + ' ' + JSON.stringify(r.body));
  });

  // ──────────────────────────────────────────
  //  Rooms — CRUD
  // ──────────────────────────────────────────
  await suite('Rooms /api/rooms', async () => {
    let r = await req('POST', '/api/rooms', { roomName: '101测试教室' }, teacherToken);
    check('POST / create → 200', r.status === 200 && r.body.ok && r.body.room.roomName === '101测试教室',
      r.status + ' ' + JSON.stringify(r.body));
    roomId = r.body.room.id;
    joinCode = r.body.room.joinCode;
    debug(`roomId=${roomId} joinCode=${joinCode}`);

    r = await req('POST', '/api/rooms', { roomName: '' }, teacherToken);
    check('POST / empty name → 400', r.status === 400,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('GET', '/api/rooms', null, teacherToken);
    check('GET / list → has room', r.status === 200 && r.body.rooms.some(rm => rm.id === roomId),
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('GET', `/api/rooms/${roomId}`, null, teacherToken);
    check('GET /:id → 200', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('GET', '/api/rooms/nonexistent', null, teacherToken);
    check('GET /:id not found → 404', r.status === 404,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('PUT', `/api/rooms/${roomId}`, { roomName: '102测试教室' }, teacherToken);
    check('PUT /:id → renamed', r.status === 200 && r.body.room.roomName === '102测试教室',
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('PUT', `/api/rooms/${roomId}`, { guard: { checkInterval: 5000, notifyOnly: true } }, teacherToken);
    check('PUT /:id → guard config updated', r.status === 200 && r.body.room.guard.checkInterval === 5000 && r.body.room.guard.notifyOnly === true,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('PUT', `/api/rooms/${roomId}`, { schedule: { autoMode: true, gracePeriod: 30 } }, teacherToken);
    check('PUT /:id → schedule config updated', r.status === 200 && r.body.room.schedule.autoMode === true && r.body.room.schedule.gracePeriod === 30,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('PUT', `/api/rooms/${roomId}`, { whitelist: { processes: ['notepad.exe', 'calc.exe'] } }, teacherToken);
    check('PUT /:id → whitelist updated', r.status === 200 && r.body.room.whitelist.processes.includes('notepad.exe'),
      r.status + ' ' + JSON.stringify(r.body));
  });

  // ──────────────────────────────────────────
  //  Rooms — Actions (start / stop / broadcast)
  // ──────────────────────────────────────────
  await suite('Rooms actions', async () => {
    let r = await req('POST', `/api/rooms/${roomId}/start`, null, teacherToken);
    check('POST /:id/start → 200', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('POST', `/api/rooms/${roomId}/stop`, null, teacherToken);
    check('POST /:id/stop → 200', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('POST', `/api/rooms/${roomId}/broadcast`, { message: '' }, teacherToken);
    check('POST /:id/broadcast empty → 400', r.status === 400,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('POST', `/api/rooms/${roomId}/broadcast`, { message: '测试广播消息' }, teacherToken);
    check('POST /:id/broadcast valid → 200', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    // Test on non-existent room
    r = await req('POST', '/api/rooms/nonexistent/start', null, teacherToken);
    check('POST /nonexistent/start → 404', r.status === 404,
      r.status + ' ' + JSON.stringify(r.body));
  });

  // ──────────────────────────────────────────
  //  Rooms — Student Management
  // ──────────────────────────────────────────
  await suite('Rooms /api/rooms/:id/students', async () => {
    let r = await req('POST', `/api/rooms/${roomId}/students`, { studentId: 'S001', name: '王小明' }, teacherToken);
    check('POST /students add → 200', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('POST', `/api/rooms/${roomId}/students`, { studentId: 'S001', name: '王小明' }, teacherToken);
    check('POST /students duplicate → 400', r.status === 400,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('POST', `/api/rooms/${roomId}/students`, { studentId: '', name: '无名' }, teacherToken);
    check('POST /students empty sid → 400', r.status === 400,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('POST', `/api/rooms/${roomId}/students`, { studentId: 'S002', name: '李小华' }, teacherToken);
    check('POST /students second → 200', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('GET', `/api/rooms/${roomId}/students`, null, teacherToken);
    check('GET /students → count 2', r.status === 200 && r.body.students.length === 2,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('DELETE', `/api/rooms/${roomId}/students/S002`, null, teacherToken);
    check('DELETE /students/:sid → done', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('GET', `/api/rooms/${roomId}/students`, null, teacherToken);
    check('GET /students → count 1 after delete', r.status === 200 && r.body.students.length === 1,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('DELETE', `/api/rooms/${roomId}/students/NONEXIST`, null, teacherToken);
    check('DELETE /students/:sid not found → 404', r.status === 404,
      r.status + ' ' + JSON.stringify(r.body));
  });

  // ──────────────────────────────────────────
  //  Student — HTTP Bind
  // ──────────────────────────────────────────
  await suite('Student /api/student/bind', async () => {
    let r = await req('POST', '/api/student/bind', {});
    check('POST /bind empty → 400', r.status === 400,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('POST', '/api/student/bind', { joinCode: 'XXXXXX', studentId: 'S001' });
    check('POST /bind bad code → 404', r.status === 404,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('POST', '/api/student/bind', { joinCode, studentId: 'S001', name: '王小明' });
    check('POST /bind valid → 200', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));
  });

  // ──────────────────────────────────────────
  //  WebSocket — Connection & Messaging
  // ──────────────────────────────────────────
  await suite('WebSocket /guardian-ws', async () => {
    ws = await wsConnect();
    check('connect → success', !!ws, 'connect failed');

    const welcome = await wsWait(ws, 'welcome');
    check('welcome message received', welcome && welcome.clientId,
      JSON.stringify(welcome));
    clientId = welcome.clientId;

    // WS bind with valid code + existing student
    wsSend(ws, { type: 'bind', roomCode: joinCode, studentId: 'S001', name: '王小明', hostname: 'PC-01' });
    const bindAck = await wsWait(ws, 'bind-ack');
    check('WS bind → ok', bindAck && bindAck.ok,
      JSON.stringify(bindAck));

    // WS heartbeat
    wsSend(ws, { type: 'heartbeat', guardActive: true, processCount: 5, violations: [] });
    const hbAck = await wsWait(ws, 'heartbeat-ack');
    check('WS heartbeat → ack', hbAck && hbAck.type === 'heartbeat-ack',
      JSON.stringify(hbAck));

    // WS violation-log (fire-and-forget, no ack expected)
    wsSend(ws, { type: 'violation-log', violations: [{ process: 'notepad.exe', pid: 1234, title: 'test', time: Date.now() }] });
    check('WS violation-log sent (no ack)', true, 'n/a');

    // Broadcast from teacher → received by WS client
    let r = await req('POST', `/api/rooms/${roomId}/broadcast`, { message: 'WS收到请回复' }, teacherToken);
    check('Teacher broadcast → sent', r.status === 200 && r.body.ok && r.body.sent > 0,
      r.status + ' ' + JSON.stringify(r.body));

    const bcMsg = await wsWait(ws, 'broadcast');
    check('WS received broadcast', bcMsg && bcMsg.message === 'WS收到请回复',
      JSON.stringify(bcMsg));
  });

  // ──────────────────────────────────────────
  //  Rooms — Client-specific operations
  // ──────────────────────────────────────────
  await suite('Rooms /api/rooms/:id/clients', async () => {
    let r = await req('GET', `/api/rooms/${roomId}/clients`, null, teacherToken);
    check('GET /clients → client listed',
      r.status === 200 && r.body.clients.some(c => c.clientId === clientId),
      r.status + ' ' + JSON.stringify(r.body));

    // toggle-guard via WS
    r = await req('POST', `/api/rooms/${roomId}/clients/${clientId}/toggle-guard`, { enabled: false }, teacherToken);
    check('POST /clients/:cid/toggle-guard → 200', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    const toggleMsg = await wsWait(ws, 'toggle-guard');
    check('WS received toggle-guard', toggleMsg && toggleMsg.enabled === false,
      JSON.stringify(toggleMsg));

    // force-kill via WS
    r = await req('POST', `/api/rooms/${roomId}/clients/${clientId}/kill`, { pid: 9999 }, teacherToken);
    check('POST /clients/:cid/kill → 200', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    const killMsg = await wsWait(ws, 'force-kill-process');
    check('WS received force-kill', killMsg && killMsg.pid === 9999,
      JSON.stringify(killMsg));

    // update-whitelist via WS
    r = await req('POST', `/api/rooms/${roomId}/clients/${clientId}/update-whitelist`, { whitelist: { processes: ['safe.exe'] } }, teacherToken);
    check('POST /clients/:cid/update-whitelist → 200', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    const wlMsg = await wsWait(ws, 'update-whitelist');
    check('WS received update-whitelist', wlMsg && wlMsg.whitelist && wlMsg.whitelist.processes.includes('safe.exe'),
      JSON.stringify(wlMsg));

    // Non-existent client
    r = await req('POST', `/api/rooms/${roomId}/clients/bogus/toggle-guard`, { enabled: true }, teacherToken);
    check('POST /clients/bogus/toggle-guard → 404', r.status === 404,
      r.status + ' ' + JSON.stringify(r.body));
  });

  // ──────────────────────────────────────────
  //  Admin — Room listing
  // ──────────────────────────────────────────
  await suite('Admin rooms', async () => {
    let r = await req('GET', '/api/admin/rooms', null, adminToken);
    check('GET /api/admin/rooms → list', r.status === 200 && r.body.rooms.length > 0,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('GET', `/api/admin/rooms/${roomId}`, null, adminToken);
    check('GET /api/admin/rooms/:id → detail', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('GET', '/api/admin/rooms/nonexistent', null, adminToken);
    check('GET /api/admin/rooms/:id not found → 404', r.status === 404,
      r.status + ' ' + JSON.stringify(r.body));
  });

  // ──────────────────────────────────────────
  //  Teacher — Password change
  // ──────────────────────────────────────────
  await suite('Teacher password', async () => {
    let r = await req('PUT', '/api/teacher/password', { oldPassword: 'wrong', newPassword: '654321' }, teacherToken);
    check('PUT /password bad old → 401', r.status === 401,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('PUT', '/api/teacher/password', { oldPassword: '123456', newPassword: '654321' }, teacherToken);
    check('PUT /password correct → ok', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    const staffId = (await (await req('GET', `/api/admin/teachers/${teacherId}`, null, adminToken)).body).teacher.staffId;
    r = await req('POST', '/api/teacher/login', { staffId, password: '654321' });
    check('POST /login with new password → ok', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    // restore original
    await req('PUT', '/api/teacher/password', { oldPassword: '654321', newPassword: '123456' }, teacherToken);
  });

  // ──────────────────────────────────────────
  //  Auth — No-token access to all protected routes
  // ──────────────────────────────────────────
  await suite('Protected routes without auth', async () => {
    let checks = [
      await req('GET', '/api/rooms', null),
      await req('POST', '/api/rooms', { roomName: 'x' }),
      await req('PUT', '/api/teacher/password', { oldPassword: 'x', newPassword: 'y' }),
    ];
    check('All return 401 without token', checks.every(r => r.status === 401),
      checks.map(r => r.status).join(', '));
  });

  // ──────────────────────────────────────────
  //  Cleanup
  // ──────────────────────────────────────────
  await suite('Cleanup', async () => {
    if (ws) ws.close();

    let r = await req('DELETE', `/api/rooms/${roomId}`, null, teacherToken);
    check('DELETE /api/rooms/:id (teacher) → done', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('DELETE', `/api/admin/teachers/${teacherId}`, null, adminToken);
    check('DELETE /api/admin/teachers/:id → done', r.status === 200 && r.body.ok,
      r.status + ' ' + JSON.stringify(r.body));

    r = await req('DELETE', '/api/admin/teachers/nonexistent', null, adminToken);
    check('DELETE /api/admin/teachers/:id not found → 404', r.status === 404,
      r.status + ' ' + JSON.stringify(r.body));
  });

  // ──────────────────────────────────────────
  //  Summary
  // ──────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${GRAY}${'─'.repeat(50)}${RESET}`);
  console.log(`${GREEN}${passed}${RESET} passed, ${RED}${failed}${RESET} failed, ${total} total`);

  httpServer.close(() => process.exit(failed ? 1 : 0));
}

main().catch(err => { console.error(err); process.exit(1); });
