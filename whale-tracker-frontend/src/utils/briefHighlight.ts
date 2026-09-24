/** 诊币正文：转义 + **加粗** + 数字高亮 + 方向着色 */

function escapeHtml(s: string) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BULL_RE = /(偏多|看多|做多|利好|多头)/g;
const BEAR_RE = /(偏空|看空|做空|利空|空头|承压)/g;
const NEUTRAL_RE = /(震荡|观望|中性)/g;

/** 高亮数字（含千分位与小数），不改文字 */
export function highlightNumbersHtml(text: string | null | undefined): string {
  if (!text) return '';
  const escaped = escapeHtml(String(text));
  return escaped.replace(
    /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+)/g,
    '<strong class="hl-num">$1</strong>',
  );
}

function colorDirections(escaped: string) {
  return escaped
    .replace(BULL_RE, '<span class="hl-bull">$1</span>')
    .replace(BEAR_RE, '<span class="hl-bear">$1</span>')
    .replace(NEUTRAL_RE, '<span class="hl-neutral">$1</span>');
}

/** 正文：数字高亮 + **强调** + 方向着色 */
export function highlightBriefHtml(text: string | null | undefined): string {
  if (!text) return '';
  const escaped = escapeHtml(String(text));
  const withBold = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong class="hl-key">$1</strong>');
  const withNums = withBold.replace(
    /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+)/g,
    '<strong class="hl-num">$1</strong>',
  );
  return colorDirections(withNums).replace(/\n/g, '<br/>');
}

export function directionToneClass(dir?: string) {
  const t = String(dir || '');
  if (/偏多|看多|做多|利好/.test(t)) return 'tone-buy';
  if (/偏空|看空|做空|利空|承压/.test(t)) return 'tone-sell';
  return 'tone-wait';
}

/** 行内：金额/涨跌着色（分析弹窗用） */
function analyzeInlineHtml(raw: string): string {
  let s = escapeHtml(raw);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 带符号的百分比 / 盈亏金额
  s = s.replace(
    /([+\-]?\s*\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*[万亿]?%?|\+\d+(?:\.\d+)?%|-\d+(?:\.\d+)?%)/g,
    (m) => {
      const t = m.replace(/\s+/g, '');
      if (/^[+\-]/.test(t) || /[+\-]/.test(t.slice(0, 2))) {
        if (t.includes('-') && !t.startsWith('+')) {
          return `<span class="text-red">${m}</span>`;
        }
        if (t.includes('+')) return `<span class="text-green">${m}</span>`;
      }
      if (/\$|万|亿/.test(t)) return `<span class="text-blue">${m}</span>`;
      return `<span class="data-badge">${m}</span>`;
    },
  );
  s = s
    .replace(BULL_RE, '<span class="text-green">$1</span>')
    .replace(BEAR_RE, '<span class="text-red">$1</span>')
    .replace(NEUTRAL_RE, '<span class="text-yellow">$1</span>');
  return s;
}

/** 章节正文（列表 / 段落），不含标题 */
export function formatAnalyzeBodyHtml(text: string | null | undefined): string {
  if (!text) return '';
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trimEnd().trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    // 正文里偶发再出现标题时跳过，避免嵌套
    if (/^#{1,3}\s+/.test(trimmed) || /^[一二三四五六七八九十]+[、.．]/.test(trimmed)) {
      closeList();
      continue;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        out.push('<ul class="analysis-list">');
        inList = true;
      }
      out.push(`<li>${analyzeInlineHtml(bullet[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p class="analysis-p">${analyzeInlineHtml(trimmed)}</p>`);
  }
  closeList();
  return out.join('');
}

/**
 * 将 AI 分析 Markdown 粗略转为参考弹窗结构：
 * ## 标题 + `- ` 列表 + 行内高亮
 */
export function formatAnalyzeHtml(text: string | null | undefined): string {
  if (!text) return '';
  const sections = parseAnalyzeSections(text);
  if (!sections.length) return formatAnalyzeBodyHtml(text);
  return sections
    .map(
      (s) =>
        `<div class="section-title">${analyzeInlineHtml(s.title)}</div>${s.html}`,
    )
    .join('');
}

export type AnalyzeSection = {
  key: string;
  /** 完整标题，如「一、仓位结构」 */
  title: string;
  /** Tab 短名，如「仓位结构」 */
  shortTitle: string;
  html: string;
};

function shortSectionTitle(title: string): string {
  return String(title || '')
    .replace(/^#{1,3}\s*/, '')
    .replace(/^[一二三四五六七八九十]+[、.．]\s*/, '')
    .replace(/^\d+[、.．]\s*/, '')
    .trim() || title;
}

/** 按 ## / 一、二、 标题拆成 Tab 章节 */
export function parseAnalyzeSections(text: string | null | undefined): AnalyzeSection[] {
  if (!text) return [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const sections: { title: string; body: string[] }[] = [];
  let current: { title: string; body: string[] } | null = null;
  let preface: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trimEnd().trim();
    const heading =
      trimmed.match(/^#{1,3}\s+(.+)$/) ||
      trimmed.match(/^([一二三四五六七八九十]+[、.．].+)$/);
    if (heading) {
      const title = (heading[1] || trimmed).replace(/^#+\s*/, '').trim();
      current = { title, body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(rawLine);
    else if (trimmed) preface.push(rawLine);
  }

  if (!sections.length && preface.length) {
    return [
      {
        key: 'all',
        title: '分析结果',
        shortTitle: '全部',
        html: formatAnalyzeBodyHtml(preface.join('\n')),
      },
    ];
  }

  const out: AnalyzeSection[] = [];
  if (preface.length) {
    out.push({
      key: 'preface',
      title: '概述',
      shortTitle: '概述',
      html: formatAnalyzeBodyHtml(preface.join('\n')),
    });
  }
  sections.forEach((s, i) => {
    out.push({
      key: `s${i}-${shortSectionTitle(s.title)}`,
      title: s.title,
      shortTitle: shortSectionTitle(s.title),
      html: formatAnalyzeBodyHtml(s.body.join('\n')),
    });
  });
  return out;
}
