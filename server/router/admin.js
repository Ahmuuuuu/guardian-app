const { Router } = require('express');
const accountService = require('../service/account/account-service');
const stateService = require('../service/runtime/runtime-state-service');
const { makeToken, requireAdmin } = require('../utils/auth');

const router = Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!accountService.verifyAdmin(username, password)) {
    return res.status(401).json({ ok: false, msg: '用户名或密码错误' });
  }

  res.json({
    ok: true,
    token: makeToken({ role: 'admin', username }),
    role: 'admin',
    username
  });
});

router.use(...requireAdmin);

router.get('/teachers', (req, res) => {
  res.json({ ok: true, teachers: accountService.listTeachers() });
});

router.post('/teachers', (req, res) => {
  const result = accountService.createTeacher(req.body || {});
  if (!result.ok) {
    const status = result.msg === '工号已存在' ? 400 : 400;
    return res.status(status).json({ ok: false, msg: result.msg });
  }
  return res.json({ ok: true, teacher: result.teacher });
});

router.get('/teachers/:id', (req, res) => {
  const teacher = accountService.getTeacherById(req.params.id);
  if (!teacher) {
    return res.status(404).json({ ok: false, msg: '教师不存在' });
  }
  return res.json({ ok: true, teacher });
});

router.put('/teachers/:id', (req, res) => {
  const result = accountService.updateTeacher(req.params.id, req.body || {});
  if (!result.ok) {
    return res.status(result.status || 400).json({ ok: false, msg: result.msg });
  }
  return res.json({ ok: true, teacher: result.teacher });
});

router.delete('/teachers/:id', async (req, res) => {
  const ownedRooms = await stateService.listRoomsByTeacher(req.params.id);
  if (ownedRooms.length > 0) {
    return res.status(400).json({ ok: false, msg: '该教师名下还有房间，无法删除' });
  }

  const result = accountService.deleteTeacher(req.params.id);
  if (!result.ok) {
    return res.status(result.status || 400).json({ ok: false, msg: result.msg });
  }
  return res.json({ ok: true });
});

router.get('/rooms', async (req, res) => {
  const teachers = accountService.listTeachers();
  const teacherNameMap = new Map(teachers.map(teacher => [teacher.id, teacher.name]));

  const roomsData = await stateService.listRooms();
  const rooms = await Promise.all(roomsData.map(async room => ({
    ...room,
    teacherName: teacherNameMap.get(room.teacherId) || '',
    studentCount: Array.isArray(room.students) ? room.students.length : 0,
    onlineCount: await stateService.countOnlineClients(room.id)
  })));

  res.json({ ok: true, rooms });
});

router.get('/rooms/:id', async (req, res) => {
  const room = await stateService.getRoomById(req.params.id);
  if (!room) {
    return res.status(404).json({ ok: false, msg: '房间不存在' });
  }

  return res.json({
    ok: true,
    room: {
      ...room,
      clients: await stateService.listRoomClientsView(room.id)
    }
  });
});

router.delete('/rooms/:id', async (req, res) => {
  if (await stateService.countOnlineClients(req.params.id) > 0) {
    return res.status(400).json({ ok: false, msg: '房间内还有在线子机，无法删除' });
  }

  const result = await stateService.deleteRoom(req.params.id);
  if (!result.ok) {
    return res.status(result.status || 400).json({ ok: false, msg: result.msg });
  }
  return res.json({ ok: true });
});

module.exports = router;
