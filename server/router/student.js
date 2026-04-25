const { Router } = require('express');
const stateService = require('../service/runtime/runtime-state-service');

const router = Router();

router.post('/bind', async (req, res) => {
  const { joinCode, studentId, name, hostname, clientId } = req.body || {};

  if (!joinCode || !studentId) {
    return res.status(400).json({ ok: false, msg: '缺少接入码或学号' });
  }

  const room = await stateService.findRoomByJoinCode(joinCode);
  if (!room) {
    return res.status(404).json({ ok: false, msg: '无效的接入码' });
  }

  const student = await stateService.findStudentInRoom(room, studentId);
  if (!student) {
    return res.status(404).json({ ok: false, msg: '该学号未在本房间注册' });
  }

  if (clientId) {
    await stateService.bindClient(clientId, {
      roomId: room.id,
      studentId: student.studentId,
      studentName: name || student.name,
      hostname: hostname || ''
    });
  }

  return res.json({
    ok: true,
    studentId: student.studentId,
    name: name || student.name,
    roomId: room.id,
    roomName: room.roomName
  });
});

module.exports = router;
