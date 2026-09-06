const express = require('express');
const {
  listUsers,
  createUser,
  deleteUser,
  updateUserPassword,
  login,
  destroySession,
  readSettings,
  writeSettings,
  extractBearer,
  requireUser,
} = require('../lib/authStore');

const router = express.Router();

router.get('/users', (_req, res) => {
  try {
    res.json({ users: listUsers() });
  } catch (err) {
    console.error('[GET /auth/users]', err);
    res.status(500).json({ error: err.message || '读取用户失败' });
  }
});

router.post('/users', (req, res) => {
  try {
    const user = createUser(req.body?.username, req.body?.password);
    res.json({ ok: true, user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '创建用户失败' });
  }
});

router.delete('/users/:id', (req, res) => {
  try {
    const user = deleteUser(req.params.id);
    res.json({ ok: true, user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '删除用户失败' });
  }
});

router.put('/users/:id/password', (req, res) => {
  try {
    const user = updateUserPassword(req.params.id, req.body?.password);
    res.json({ ok: true, user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '修改密码失败' });
  }
});

router.post('/login', (req, res) => {
  try {
    const data = login(req.body?.username, req.body?.password);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '登录失败' });
  }
});

router.post('/logout', (req, res) => {
  try {
    destroySession(extractBearer(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || '退出失败' });
  }
});

router.get('/me', (req, res) => {
  try {
    const session = requireUser(req);
    const settings = readSettings(session.user.id);
    res.json({
      ok: true,
      user: session.user,
      expiresAt: session.expiresAt,
      settings: settings.settings,
      settingsUpdatedAt: settings.updatedAt,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '未登录' });
  }
});

router.get('/settings', (req, res) => {
  try {
    const session = requireUser(req);
    const data = readSettings(session.user.id);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '读取设置失败' });
  }
});

router.put('/settings', (req, res) => {
  try {
    const session = requireUser(req);
    const incoming = req.body?.settings;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'settings 必须是对象' });
    }
    const prev = readSettings(session.user.id).settings || {};
    const merged = { ...prev, ...incoming };
    const data = writeSettings(session.user.id, merged);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '保存设置失败' });
  }
});

module.exports = router;
