const crypto = require('crypto');
const db = require('../../sql/db');

let initialized = false;

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function hashPassword(raw) {
  return crypto.createHash('sha256').update(String(raw ?? '')).digest('hex');
}

function safeTeacher(teacher) {
  if (!teacher) return null;
  const { password, ...rest } = teacher;
  return rest;
}

function isTeacherStaffIdConflict(error) {
  if (!error) return false;
  return (
    error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    /UNIQUE constraint failed:\s*teachers\.staff_id/i.test(String(error.message || ''))
  );
}

function init() {
  if (initialized) return;
  db.initDB();
  initialized = true;
}

function ensureInit() {
  if (!initialized) init();
}

function verifyAdmin(username, password) {
  ensureInit();
  const account = db.getAdmin(String(username || '').trim());
  if (!account) return false;
  return account.password === hashPassword(password);
}

function getAdmin(username) {
  ensureInit();
  return db.getAdmin(String(username || '').trim());
}

function insertAdmin(data = {}) {
  ensureInit();
  db.insertAdmin({
    id: data.id || randomId('a'),
    username: String(data.username || '').trim(),
    password: hashPassword(data.password),
    createdAt: data.createdAt || nowIso()
  });
}

function listTeachers() {
  ensureInit();
  return db.listTeachers().map(safeTeacher);
}

function getTeacherById(id) {
  ensureInit();
  return safeTeacher(db.getTeacher(id));
}

function createTeacher(payload = {}) {
  ensureInit();

  const staffId = String(payload.staffId || '').trim();
  const name = String(payload.name || '').trim();
  const password = String(payload.password || '');

  if (!staffId || !name || !password) {
    return { ok: false, msg: '缺少必要字段' };
  }

  if (db.getTeacherByStaffId(staffId)) {
    return { ok: false, msg: '工号已存在' };
  }

  const teacher = {
    id: randomId('t'),
    staffId,
    name,
    password: hashPassword(password),
    createdAt: nowIso()
  };

  try {
    db.insertTeacher(teacher);
    return { ok: true, teacher: safeTeacher(db.getTeacher(teacher.id)) };
  } catch (error) {
    if (isTeacherStaffIdConflict(error)) {
      return { ok: false, msg: '工号已存在' };
    }
    return { ok: false, status: 500, msg: '数据库错误' };
  }
}

function updateTeacher(id, payload = {}) {
  ensureInit();

  const current = db.getTeacher(id);
  if (!current) {
    return { ok: false, status: 404, msg: '教师不存在' };
  }

  const fields = {};

  if (payload.staffId !== undefined) {
    const staffId = String(payload.staffId || '').trim();
    if (!staffId) {
      return { ok: false, msg: '工号不能为空' };
    }
    const duplicate = db.getTeacherByStaffId(staffId);
    if (duplicate && duplicate.id !== id) {
      return { ok: false, msg: '工号已存在' };
    }
    fields.staffId = staffId;
  }

  if (payload.name !== undefined) {
    const name = String(payload.name || '').trim();
    if (!name) {
      return { ok: false, msg: '姓名不能为空' };
    }
    fields.name = name;
  }

  if (payload.password !== undefined) {
    fields.password = hashPassword(payload.password);
  }

  try {
    if (Object.keys(fields).length > 0) {
      db.updateTeacher(id, fields);
    }
    return { ok: true, teacher: safeTeacher(db.getTeacher(id)) };
  } catch (error) {
    if (isTeacherStaffIdConflict(error)) {
      return { ok: false, msg: '工号已存在' };
    }
    return { ok: false, status: 500, msg: '数据库错误' };
  }
}

function deleteTeacher(id) {
  ensureInit();

  const teacher = db.getTeacher(id);
  if (!teacher) {
    return { ok: false, status: 404, msg: '教师不存在' };
  }

  const deleted = db.deleteTeacher(id);
  if (!deleted) {
    return { ok: false, status: 404, msg: '教师不存在' };
  }
  return { ok: true };
}

function verifyTeacher(staffId, password) {
  ensureInit();
  const teacher = db.getTeacherByStaffId(String(staffId || '').trim());
  if (!teacher || teacher.password !== hashPassword(password)) {
    return null;
  }
  return safeTeacher(teacher);
}

function updateTeacherPassword(id, oldPassword, newPassword) {
  ensureInit();

  const teacher = db.getTeacher(id);
  if (!teacher) {
    return { ok: false, status: 404, msg: '教师不存在' };
  }
  if (teacher.password !== hashPassword(oldPassword)) {
    return { ok: false, status: 401, msg: '旧密码错误' };
  }

  db.updateTeacher(id, { password: hashPassword(newPassword) });
  return { ok: true };
}

module.exports = {
  init,
  verifyAdmin,
  getAdmin,
  insertAdmin,
  listTeachers,
  getTeacherById,
  createTeacher,
  updateTeacher,
  deleteTeacher,
  verifyTeacher,
  updateTeacherPassword
};
