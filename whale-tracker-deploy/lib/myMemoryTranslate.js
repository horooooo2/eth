/**
 * 机翻 en→zh：优先 MyMemory，失败回退 Google gtx（免费非官方，仅作轻量补全）。
 */
const axios = require('axios');

const MAX_Q = 450;

function looksChinese(text) {
  const s = String(text || '');
  if (!s.trim()) return true;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  return cjk > 0 && cjk >= letters * 0.4;
}

function needsLatinTranslate(text) {
  return /[A-Za-z\u00C0-\u024F]{2,}/.test(String(text || ''));
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function translateMyMemory(q) {
  const { data } = await axios.get('https://api.mymemory.translated.net/get', {
    params: { q, langpair: 'en|zh-CN' },
    timeout: 20_000,
  });
  const out = String(data?.responseData?.translatedText || '').trim();
  if (!out || /MYMEMORY WARNING/i.test(out)) {
    const err = new Error('mymemory_empty');
    err.code = 'EMPTY';
    throw err;
  }
  return out;
}

/** Google 公开 translate_a（无 Key，不稳定，仅 fallback） */
async function translateGoogleGtx(q) {
  const { data } = await axios.get('https://translate.googleapis.com/translate_a/single', {
    params: {
      client: 'gtx',
      sl: 'auto',
      tl: 'zh-CN',
      dt: 't',
      q,
    },
    timeout: 20_000,
  });
  const chunks = Array.isArray(data?.[0]) ? data[0] : [];
  const out = chunks
    .map((row) => (Array.isArray(row) ? String(row[0] || '') : ''))
    .join('')
    .trim();
  if (!out) {
    const err = new Error('gtx_empty');
    err.code = 'EMPTY';
    throw err;
  }
  return out;
}

async function translateToZh(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (looksChinese(raw)) return raw;
  if (!needsLatinTranslate(raw)) return raw;
  const q = raw.length > MAX_Q ? `${raw.slice(0, MAX_Q)}…` : raw;

  try {
    return await translateMyMemory(q);
  } catch (err) {
    if (err.response?.status && err.response.status !== 429) {
      console.warn('[translate] MyMemory:', err.response?.status || err.message);
    }
  }

  try {
    return await translateGoogleGtx(q);
  } catch (err) {
    console.warn('[translate] Google gtx failed:', err.response?.status || err.message);
    return '';
  }
}

async function translateOne(t, { gapMs = 500 } = {}) {
  if (!t || t.textZh) return false;
  if (looksChinese(t.text) || t.lang === 'zh' || t.lang === 'zh-cn') {
    t.textZh = t.text;
    return false;
  }
  if (!needsLatinTranslate(t.text)) {
    t.textZh = t.text;
    return false;
  }
  const zh = await translateToZh(t.text);
  if (zh) t.textZh = zh;
  if (gapMs > 0) await sleep(gapMs);
  return Boolean(zh);
}

/** 翻译主推文 + 引用/转发嵌套正文 */
async function translateTweets(tweets, { gapMs = 500 } = {}) {
  const list = Array.isArray(tweets) ? tweets : [];
  for (const t of list) {
    if (!t) continue;
    await translateOne(t, { gapMs });
    if (t.refTweet) await translateOne(t.refTweet, { gapMs });
  }
  return list;
}

module.exports = {
  looksChinese,
  translateToZh,
  translateTweets,
  translateOne,
};
