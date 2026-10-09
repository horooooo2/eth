export type NewsChatMessage = { role: 'user' | 'assistant'; content: string; at: number };
export const NEWS_CHAT_TTL = 7 * 24 * 3600000;
const PREFIX = 'news-chat-v1:';
let lastPrunedAt = -Infinity;
export function cleanNewsChat(value: unknown, now = Date.now()): NewsChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((m): m is NewsChatMessage => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && Number.isFinite(m.at) && m.at <= now && now - m.at < NEWS_CHAT_TTL);
}
export function chatKey(user: string, symbol: string, article: string) { return PREFIX + JSON.stringify([user, symbol, article]); }
export function readNewsChat(key: string): NewsChatMessage[] { try { return cleanNewsChat(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return []; } }
export function saveNewsChat(key: string, messages: NewsChatMessage[]) { const rows = cleanNewsChat(messages); if (rows.length) localStorage.setItem(key, JSON.stringify(rows)); else localStorage.removeItem(key); }
export function pruneNewsChats() {
  const now = Date.now();
  if (now - lastPrunedAt < 600000) return;
  lastPrunedAt = now;
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(key);
      let parsed: unknown;
      try { parsed = JSON.parse(raw || '[]'); } catch { localStorage.removeItem(key); continue; }
      const rows = cleanNewsChat(parsed, now);
      if (!rows.length) localStorage.removeItem(key);
      else if (!Array.isArray(parsed) || rows.length !== parsed.length) localStorage.setItem(key, JSON.stringify(rows));
    }
  } catch { /* Reads still filter expired messages when storage is unavailable. */ }
}
