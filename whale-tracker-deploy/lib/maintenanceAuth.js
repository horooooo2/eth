const { requireUser } = require('./authStore');

function requireAuthenticated(req, res, next) {
  try { req.session = requireUser(req); next(); }
  catch (err) { res.status(err.status || 401).json({ error: err.message }); }
}

function requireAdmin(req, res, next) {
  requireAuthenticated(req, res, () => {
    if (req.session.user?.role !== 'admin') return res.status(403).json({ error: '此操作需要管理员权限' });
    next();
  });
}

module.exports = { requireAuthenticated, requireAdmin };
