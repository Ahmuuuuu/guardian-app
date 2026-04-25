const crypto = require('crypto');
const memory = require('../../store/memory');

const JOIN_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeString(value) {
  return String(value ?? '').trim();
}

function getOnline(client) {
  return Boolean(client && client.ws && client.ws.readyState === 1);
}

function defaultRoomConfig() {
  return {
    guard: {
      checkInterval: 3000,
      notifyOnly: false,
      autoStartGuard: true
    },
    schedule: {
      autoMode: false,
      gracePeriod: 15,
      allowLateJoin: true
    },
    whitelist: {
      processes: [],
      browsers: [],
      urls: []
    },
    violations: {
      maxAllowed: 0
    }
  };
}

function mergeRoomConfig(payload = {}) {
  const defaults = defaultRoomConfig();
  const source = payload || {};
  return {
    guard: { ...defaults.guard, ...(source.guard || {}) },
    schedule: { ...defaults.schedule, ...(source.schedule || {}) },
    whitelist: {
      processes: Array.isArray(source.whitelist?.processes) ? [...source.whitelist.processes] : defaults.whitelist.processes,
      browsers: Array.isArray(source.whitelist?.browsers) ? [...source.whitelist.browsers] : defaults.whitelist.browsers,
      urls: Array.isArray(source.whitelist?.urls) ? [...source.whitelist.urls] : defaults.whitelist.urls
    },
    violations: { ...defaults.violations, ...(source.violations || {}) }
  };
}

function generateJoinCode() {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += JOIN_CODE_CHARS[Math.floor(Math.random() * JOIN_CODE_CHARS.length)];
  }
  return code;
}

function cloneStudent(student) {
  return {
    studentId: student.studentId,
    name: student.name
  };
}

function toPublicRoom(room) {
  return {
    id: room.id,
    roomName: room.roomName,
    joinCode: room.joinCode,
    teacherId: room.teacherId,
    createdAt: room.createdAt,
    guard: { ...room.guard },
    schedule: { ...room.schedule },
    whitelist: {
      processes: [...room.whitelist.processes],
      browsers: [...room.whitelist.browsers],
      urls: [...room.whitelist.urls]
    },
    violations: { ...room.violations },
    students: room.students.map(cloneStudent)
  };
}

function sanitizeStudents(students) {
  if (!Array.isArray(students)) return [];
  const seen = new Set();
  const result = [];

  students.forEach(item => {
    const studentId = normalizeString(item?.studentId);
    if (!studentId || seen.has(studentId)) return;
    seen.add(studentId);
    result.push({
      studentId,
      name: normalizeString(item?.name)
    });
  });

  return result;
}

function getRoomInternal(roomId) {
  return memory.getRoom(roomId);
}

function detachClientFromRoom(client) {
  if (!client) return;
  const roomId = memory.getClientRoomId(client.clientId) || client.roomId;
  if (!roomId) return;

  const room = getRoomInternal(roomId);
  if (room) {
    room.clients.delete(client.clientId);
  }
  memory.deleteClientRoomId(client.clientId);
  client.roomId = null;
}

function removeClientInternal(clientId, terminate) {
  const client = memory.getClient(clientId);
  if (!client) return false;

  if (terminate && client.ws) {
    try {
      client.ws.terminate();
    } catch (_) {
      // ignore close error
    }
  }

  detachClientFromRoom(client);
  memory.deleteClient(clientId);
  return true;
}

function listRooms() {
  return memory.listRooms().map(toPublicRoom);
}

function listRoomsByTeacher(teacherId) {
  return memory.listRooms()
    .filter(room => room.teacherId === teacherId)
    .map(toPublicRoom);
}

function getRoomById(id) {
  const room = getRoomInternal(id);
  return room ? toPublicRoom(room) : null;
}

function createRoom(teacherId, payload = {}) {
  const roomName = normalizeString(payload.roomName);
  if (!roomName) {
    return { ok: false, msg: '房间名称不能为空' };
  }

  let joinCode = generateJoinCode();
  while (memory.hasJoinCode(joinCode)) {
    joinCode = generateJoinCode();
  }

  const config = mergeRoomConfig(payload);
  const room = {
    id: randomId('r'),
    roomName,
    joinCode,
    teacherId,
    createdAt: nowIso(),
    guard: config.guard,
    schedule: config.schedule,
    whitelist: config.whitelist,
    violations: config.violations,
    students: sanitizeStudents(payload.students),
    clients: new Map()
  };

  memory.setRoom(room);
  memory.setJoinCode(joinCode, room.id);
  return { ok: true, room: toPublicRoom(room) };
}

function updateRoom(id, payload = {}) {
  const room = getRoomInternal(id);
  if (!room) {
    return { ok: false, status: 404, msg: '房间不存在' };
  }

  if (payload.roomName !== undefined) {
    const roomName = normalizeString(payload.roomName);
    if (!roomName) {
      return { ok: false, msg: '房间名称不能为空' };
    }
    room.roomName = roomName;
  }

  if (payload.guard && typeof payload.guard === 'object') {
    room.guard = { ...room.guard, ...payload.guard };
  }
  if (payload.schedule && typeof payload.schedule === 'object') {
    room.schedule = { ...room.schedule, ...payload.schedule };
  }
  if (payload.whitelist && typeof payload.whitelist === 'object') {
    room.whitelist = {
      ...room.whitelist,
      ...(Array.isArray(payload.whitelist.processes) ? { processes: [...payload.whitelist.processes] } : {}),
      ...(Array.isArray(payload.whitelist.browsers) ? { browsers: [...payload.whitelist.browsers] } : {}),
      ...(Array.isArray(payload.whitelist.urls) ? { urls: [...payload.whitelist.urls] } : {})
    };
  }
  if (payload.violations && typeof payload.violations === 'object') {
    room.violations = { ...room.violations, ...payload.violations };
  }

  return { ok: true, room: toPublicRoom(room) };
}

function deleteRoom(id) {
  const room = getRoomInternal(id);
  if (!room) {
    return { ok: false, status: 404, msg: '房间不存在' };
  }

  for (const clientId of room.clients.keys()) {
    removeClientInternal(clientId, true);
  }

  memory.deleteJoinCode(room.joinCode);
  memory.deleteRoom(id);
  return { ok: true };
}

function listRoomStudents(roomId) {
  const room = getRoomInternal(roomId);
  if (!room) return null;
  return room.students.map(cloneStudent);
}

function addRoomStudent(roomId, payload = {}) {
  const room = getRoomInternal(roomId);
  if (!room) {
    return { ok: false, status: 404, msg: '房间不存在' };
  }

  const studentId = normalizeString(payload.studentId);
  const name = normalizeString(payload.name);
  if (!studentId || !name) {
    return { ok: false, msg: '缺少学号或姓名' };
  }

  if (room.students.some(student => student.studentId === studentId)) {
    return { ok: false, msg: '该学号已在本房间中' };
  }

  const student = { studentId, name };
  room.students.push(student);
  return { ok: true, student: cloneStudent(student) };
}

function deleteRoomStudent(roomId, studentId) {
  const room = getRoomInternal(roomId);
  if (!room) {
    return { ok: false, status: 404, msg: '房间不存在' };
  }

  const targetId = normalizeString(studentId);
  const before = room.students.length;
  room.students = room.students.filter(student => student.studentId !== targetId);

  if (before === room.students.length) {
    return { ok: false, status: 404, msg: '学生不存在' };
  }
  return { ok: true };
}

function findRoomByJoinCode(joinCode) {
  const roomId = memory.getRoomIdByJoinCode(joinCode);
  if (!roomId) return null;
  const room = getRoomInternal(roomId);
  return room ? toPublicRoom(room) : null;
}

function findStudentInRoom(room, studentId) {
  if (!room || !Array.isArray(room.students)) return null;
  const targetId = normalizeString(studentId);
  const student = room.students.find(item => item.studentId === targetId);
  return student ? cloneStudent(student) : null;
}

function createClient(ws, ip) {
  const client = {
    clientId: randomId('c'),
    ws,
    ip: String(ip || ''),
    hostname: '',
    roomId: null,
    studentId: null,
    studentName: null,
    guardActive: false,
    processCount: 0,
    violations: [],
    lastSeen: Date.now(),
    bindAt: null
  };
  memory.setClient(client);
  return client;
}

function getClient(clientId) {
  return memory.getClient(clientId);
}

function deleteClient(clientId) {
  removeClientInternal(clientId, false);
}

function touchClient(clientId) {
  const client = getClient(clientId);
  if (!client) return;
  client.lastSeen = Date.now();
}

function bindClient(clientId, payload = {}) {
  const client = getClient(clientId);
  if (!client) return null;

  const roomId = payload.roomId || client.roomId;
  const room = getRoomInternal(roomId);
  if (!room) return null;

  const nextStudentId = normalizeString(payload.studentId || client.studentId);
  const nextStudentName = normalizeString(payload.studentName || payload.name || client.studentName);

  if (client.roomId && client.roomId !== room.id) {
    detachClientFromRoom(client);
  }

  for (const [otherId, otherClient] of room.clients.entries()) {
    if (otherId === clientId) continue;
    if (nextStudentId && otherClient.studentId === nextStudentId) {
      removeClientInternal(otherId, true);
    }
  }

  client.roomId = room.id;
  client.studentId = nextStudentId || client.studentId;
  client.studentName = nextStudentName || client.studentName;
  client.hostname = normalizeString(payload.hostname || client.hostname);
  client.ip = payload.ip !== undefined ? String(payload.ip || '') : client.ip;
  client.ws = payload.ws || client.ws;
  client.bindAt = Date.now();
  client.lastSeen = Date.now();

  room.clients.set(client.clientId, client);
  memory.setClientRoomId(client.clientId, room.id);
  return client;
}

function updateClientHeartbeat(clientId, payload = {}) {
  const client = getClient(clientId);
  if (!client) return;

  client.lastSeen = Date.now();
  if (payload.guardActive !== undefined) {
    client.guardActive = Boolean(payload.guardActive);
  }
  if (payload.processCount !== undefined) {
    client.processCount = Number(payload.processCount) || 0;
  }
  if (Array.isArray(payload.violations)) {
    client.violations = [...payload.violations, ...client.violations].slice(0, 100);
  }
}

function appendClientViolations(clientId, violations = []) {
  const client = getClient(clientId);
  if (!client || !Array.isArray(violations)) return;

  client.violations = [...violations, ...client.violations].slice(0, 100);
  client.lastSeen = Date.now();
}

function listClients(filter = {}) {
  const roomId = filter.roomId || null;
  if (!roomId) return memory.listClients();

  const room = getRoomInternal(roomId);
  if (!room) return [];
  return Array.from(room.clients.values());
}

function countOnlineClients(roomId) {
  return listClients({ roomId }).filter(getOnline).length;
}

function listRoomClientsView(roomId) {
  return listClients({ roomId }).map(client => ({
    clientId: client.clientId,
    studentId: client.studentId,
    studentName: client.studentName,
    ip: client.ip,
    hostname: client.hostname,
    online: getOnline(client),
    guardActive: client.guardActive,
    processCount: client.processCount,
    lastSeen: client.lastSeen,
    violations: client.violations
  }));
}

async function sendToRoom(roomId, payload) {
  const message = JSON.stringify(payload);
  let sent = 0;
  let processed = 0;
  const batchSize = 100;

  for (const client of listClients({ roomId })) {
    if (!getOnline(client)) continue;
    try {
      client.ws.send(message);
      sent += 1;
    } catch (_) {
      // ignore send error
    }
    processed += 1;
    if (processed % batchSize === 0) {
      await yieldEventLoop();
    }
  }

  return sent;
}

function sendToClient(roomId, clientId, payload) {
  const client = getClient(clientId);
  if (!client || client.roomId !== roomId || !getOnline(client)) {
    return false;
  }

  try {
    client.ws.send(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

function yieldEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

function pruneInactiveClients(timeoutMs = 120000) {
  const now = Date.now();
  let cleaned = 0;

  memory.listClients().forEach(client => {
    if (now - client.lastSeen <= timeoutMs) return;
    if (removeClientInternal(client.clientId, true)) {
      cleaned += 1;
    }
  });

  return cleaned;
}

async function startRoomGuard(roomId) {
  return sendToRoom(roomId, { type: 'toggle-guard', enabled: true });
}

async function stopRoomGuard(roomId) {
  return sendToRoom(roomId, { type: 'toggle-guard', enabled: false });
}

module.exports = {
  listRooms: async () => listRooms(),
  listRoomsByTeacher: async teacherId => listRoomsByTeacher(teacherId),
  getRoomById: async id => getRoomById(id),
  createRoom: async (teacherId, payload) => createRoom(teacherId, payload),
  updateRoom: async (id, payload) => updateRoom(id, payload),
  deleteRoom: async id => deleteRoom(id),
  listRoomStudents: async roomId => listRoomStudents(roomId),
  addRoomStudent: async (roomId, payload) => addRoomStudent(roomId, payload),
  deleteRoomStudent: async (roomId, studentId) => deleteRoomStudent(roomId, studentId),
  findRoomByJoinCode: async joinCode => findRoomByJoinCode(joinCode),
  findStudentInRoom: async (room, studentId) => findStudentInRoom(room, studentId),
  createClient: async (ws, ip) => createClient(ws, ip),
  getClient: async clientId => getClient(clientId),
  deleteClient: async clientId => deleteClient(clientId),
  touchClient: async clientId => touchClient(clientId),
  bindClient: async (clientId, payload) => bindClient(clientId, payload),
  updateClientHeartbeat: async (clientId, payload) => updateClientHeartbeat(clientId, payload),
  appendClientViolations: async (clientId, violations) => appendClientViolations(clientId, violations),
  countOnlineClients: async roomId => countOnlineClients(roomId),
  listRoomClientsView: async roomId => listRoomClientsView(roomId),
  sendToRoom: async (roomId, payload) => sendToRoom(roomId, payload),
  sendToClient: async (roomId, clientId, payload) => sendToClient(roomId, clientId, payload),
  pruneInactiveClients: async timeoutMs => pruneInactiveClients(timeoutMs),
  startRoomGuard: async roomId => startRoomGuard(roomId),
  stopRoomGuard: async roomId => stopRoomGuard(roomId)
};
