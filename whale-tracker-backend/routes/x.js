const express = require('express');
const { getUserTweets, DEFAULT_USER } = require('../lib/sorsaTwitter');
const { getFeed, pollOnce, getStatus, backfillTranslations } = require('../lib/xFeedPoller');
const {
  listAccounts,
  addAccount,
  updateAccount,
  setAccountEnabled,
  removeAccount,
  replaceAccounts,
} = require('../lib/xWatchAccounts');

const router = express.Router();

function sendAccountError(res, err) {
  const code = err.code || '';
  const status =
    code === 'NOT_FOUND'
      ? 404
      : code === 'DUPLICATE' ||
          code === 'INVALID_USER' ||
          code === 'EMPTY' ||
          code === 'LAST_ONE'
        ? 400
        : 500;
  res.status(status).json({ error: err.message || '账号操作失败', code });
}

/** GET /api/x/feed?user=&limit=40 */
router.get('/feed', (req, res) => {
  try {
    const user = String(req.query.user || '').replace(/^@/, '');
    const limit = Number(req.query.limit) || 40;
    res.json(getFeed({ user, limit }));
  } catch (err) {
    console.error('[GET /api/x/feed]', err);
    res.status(502).json({ error: err.message || 'X feed 失败' });
  }
});

/** GET /api/x/status */
router.get('/status', (_req, res) => {
  res.json(getStatus());
});

/** POST /api/x/refresh */
router.post('/refresh', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.body?.force === true;
    const data = await pollOnce({ force });
    res.json(data);
  } catch (err) {
    console.error('[POST /api/x/refresh]', err);
    res.status(502).json({ error: err.message || 'X 刷新失败' });
  }
});

/** POST /api/x/translate */
router.post('/translate', async (_req, res) => {
  try {
    const data = await backfillTranslations();
    res.json({
      backfilled: data.backfilled,
      tweets: data.tweets?.length || 0,
      updatedAt: data.updatedAt,
    });
  } catch (err) {
    console.error('[POST /api/x/translate]', err);
    res.status(502).json({ error: err.message || '翻译补全失败' });
  }
});

/** GET /api/x/tweets */
router.get('/tweets', async (req, res) => {
  try {
    const user = String(req.query.user || DEFAULT_USER).replace(/^@/, '');
    const limit = Number(req.query.limit) || 10;
    const force = req.query.refresh === '1';
    const data = await getUserTweets(user, { force, limit });
    res.json(data);
  } catch (err) {
    console.error('[GET /api/x/tweets]', err);
    res.status(502).json({ error: err.message || 'X 推文获取失败' });
  }
});

/** GET /api/x/accounts */
router.get('/accounts', (_req, res) => {
  try {
    res.json({ ...listAccounts(), poll: getStatus() });
  } catch (err) {
    sendAccountError(res, err);
  }
});

/** POST /api/x/accounts  body: { username, label?, name? } */
router.post('/accounts', (req, res) => {
  try {
    res.json(addAccount(req.body || {}));
  } catch (err) {
    sendAccountError(res, err);
  }
});

/** PUT /api/x/accounts/:username  body: { label?, name?, enabled? } */
router.put('/accounts/:username', (req, res) => {
  try {
    res.json(updateAccount(req.params.username, req.body || {}));
  } catch (err) {
    sendAccountError(res, err);
  }
});

/** POST /api/x/accounts/:username/toggle  body: { enabled?: boolean } 省略则翻转 */
router.post('/accounts/:username/toggle', (req, res) => {
  try {
    const list = listAccounts().accounts;
    const key = String(req.params.username || '')
      .replace(/^@/, '')
      .toLowerCase();
    const cur = list.find((a) => a.username.toLowerCase() === key);
    if (!cur) {
      const err = new Error('账号不存在');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const enabled =
      req.body?.enabled != null ? Boolean(req.body.enabled) : !cur.enabled;
    res.json(setAccountEnabled(req.params.username, enabled));
  } catch (err) {
    sendAccountError(res, err);
  }
});

/** DELETE /api/x/accounts/:username */
router.delete('/accounts/:username', (req, res) => {
  try {
    res.json(removeAccount(req.params.username));
  } catch (err) {
    sendAccountError(res, err);
  }
});

/** PUT /api/x/accounts  整体替换列表 */
router.put('/accounts', (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : req.body?.accounts;
    res.json(replaceAccounts(list));
  } catch (err) {
    sendAccountError(res, err);
  }
});

module.exports = router;
