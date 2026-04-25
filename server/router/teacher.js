const { Router } = require('express');
const accountService = require('../service/account/account-service');
const { makeToken, requireTeacher } = require('../utils/auth');

const router = Router();

router.post('/login', (req, res) => {
  const { staffId, password } = req.body || {};
  const teacher = accountService.verifyTeacher(staffId, password);
  if (!teacher) {
    return res.status(401).json({ ok: false, msg: '工号或密码错误' });
  }

  return res.json({
    ok: true,
    token: makeToken({ role: 'teacher', teacherId: teacher.id, staffId: teacher.staffId, name: teacher.name }),
    teacherId: teacher.id,
    staffId: teacher.staffId,
    name: teacher.name
  });
});

router.put('/password', ...requireTeacher, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const result = accountService.updateTeacherPassword(req.auth.teacherId, oldPassword, newPassword);
  if (!result.ok) {
    return res.status(result.status || 400).json({ ok: false, msg: result.msg });
  }
  return res.json({ ok: true });
});

module.exports = router;
