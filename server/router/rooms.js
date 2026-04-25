const { Router } = require('express');
const stateService = require('../service/runtime/runtime-state-service');
const { requireTeacher } = require('../utils/auth');

const router = Router();

router.use(...requireTeacher);

async function getOwnedRoomAsync(req, res) {
  const room = await stateService.getRoomById(req.params.id);
  if (!room) {
    res.status(404).json({ ok: false, msg: '房间不存在' });
    return null;
  }
  if (room.teacherId !== req.auth.teacherId) {
    res.status(403).json({ ok: false, msg: '无权限' });
    return null;
  }
  return room;
}

router.get('/', async (req, res) => {
  const roomsData = await stateService.listRoomsByTeacher(req.auth.teacherId);
  const rooms = await Promise.all(roomsData.map(async room => ({
    ...room,
    studentCount: Array.isArray(room.students) ? room.students.length : 0,
    onlineCount: await stateService.countOnlineClients(room.id)
  })));

  res.json({ ok: true, rooms });
});

router.post('/', async (req, res) => {
  const result = await stateService.createRoom(req.auth.teacherId, req.body || {});
  if (!result.ok) {
    return res.status(400).json({ ok: false, msg: result.msg });
  }
  return res.json({ ok: true, room: result.room });
});

router.get('/:id', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;
  res.json({
    ok: true,
    room: {
      ...room,
      clients: await stateService.listRoomClientsView(room.id)
    }
  });
});

router.put('/:id', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;

  const result = await stateService.updateRoom(room.id, req.body || {});
  if (!result.ok) {
    return res.status(result.status || 400).json({ ok: false, msg: result.msg });
  }
  return res.json({ ok: true, room: result.room });
});

router.delete('/:id', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;

  if (await stateService.countOnlineClients(room.id) > 0) {
    return res.status(400).json({ ok: false, msg: '房间内还有在线子机，无法删除' });
  }

  const result = await stateService.deleteRoom(room.id);
  if (!result.ok) {
    return res.status(result.status || 400).json({ ok: false, msg: result.msg });
  }

  return res.json({ ok: true });
});

router.post('/:id/start', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;
  const sent = await stateService.sendToRoom(room.id, { type: 'toggle-guard', enabled: true });
  return res.json({ ok: true, sent });
});

router.post('/:id/stop', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;
  const sent = await stateService.sendToRoom(room.id, { type: 'toggle-guard', enabled: false });
  return res.json({ ok: true, sent });
});

router.post('/:id/broadcast', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;

  const message = String(req.body?.message || '').trim();
  if (!message) {
    return res.status(400).json({ ok: false, msg: '消息内容不能为空' });
  }

  const sent = await stateService.sendToRoom(room.id, { type: 'broadcast', message });
  return res.json({ ok: true, sent });
});

router.get('/:id/students', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;

  const students = (await stateService.listRoomStudents(room.id)) || [];
  return res.json({ ok: true, students });
});

router.post('/:id/students', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;

  const result = await stateService.addRoomStudent(room.id, req.body || {});
  if (!result.ok) {
    return res.status(result.status || 400).json({ ok: false, msg: result.msg });
  }

  return res.json({ ok: true, student: result.student });
});

router.delete('/:id/students/:studentId', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;

  const result = await stateService.deleteRoomStudent(room.id, req.params.studentId);
  if (!result.ok) {
    return res.status(result.status || 400).json({ ok: false, msg: result.msg });
  }

  return res.json({ ok: true });
});

router.get('/:id/clients', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;

  return res.json({ ok: true, clients: await stateService.listRoomClientsView(room.id) });
});

router.post('/:id/clients/:cid/toggle-guard', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;

  const client = await stateService.getClient(req.params.cid);
  if (!client || client.roomId !== room.id || !client.ws || client.ws.readyState !== 1) {
    return res.status(404).json({ ok: false, msg: '子机不在线' });
  }

  const enabled = req.body?.enabled === undefined ? !client.guardActive : Boolean(req.body.enabled);
  const ok = await stateService.sendToClient(room.id, client.clientId, { type: 'toggle-guard', enabled });
  if (!ok) {
    return res.status(404).json({ ok: false, msg: '子机不在线' });
  }

  client.guardActive = enabled;
  return res.json({ ok: true });
});

router.post('/:id/clients/:cid/kill', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;

  const client = await stateService.getClient(req.params.cid);
  if (!client || client.roomId !== room.id || !client.ws || client.ws.readyState !== 1) {
    return res.status(404).json({ ok: false, msg: '子机不在线' });
  }

  const pid = Number(req.body?.pid);
  const ok = await stateService.sendToClient(room.id, client.clientId, { type: 'force-kill-process', pid });
  if (!ok) {
    return res.status(404).json({ ok: false, msg: '子机不在线' });
  }

  return res.json({ ok: true });
});

router.post('/:id/clients/:cid/update-whitelist', async (req, res) => {
  const room = await getOwnedRoomAsync(req, res);
  if (!room) return;

  const client = await stateService.getClient(req.params.cid);
  if (!client || client.roomId !== room.id || !client.ws || client.ws.readyState !== 1) {
    return res.status(404).json({ ok: false, msg: '子机不在线' });
  }

  const ok = await stateService.sendToClient(room.id, client.clientId, {
    type: 'update-whitelist',
    whitelist: req.body?.whitelist || {}
  });

  if (!ok) {
    return res.status(404).json({ ok: false, msg: '子机不在线' });
  }

  return res.json({ ok: true });
});

module.exports = router;
