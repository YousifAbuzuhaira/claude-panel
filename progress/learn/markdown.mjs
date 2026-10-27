// A lesson's Markdown as blocks the window draws into a FlowDocument. Pure.
// Blocks: { t: 'h', level, inlines } | { t: 'p', inlines } | { t: 'code', lang, text }
//   | { t: 'ul' | 'ol', items: [{ depth, inlines }] } | { t: 'quote', inlines } | { t: 'hr' }
//   | { t: 'table', rows: [[inlines]] }   (the first row is the header)
// Inlines: { s, b?, i?, code?, link?, time?, added? }. `[12:34]` becomes a link into the
// page's video at that second (`[s4 12:34]` into source s4's, when a page has two videos);
// `[sec: Heading]` a link to that part of the source page.
import { parseTime, watchUrl } from './sources.mjs';

const INLINE = new RegExp([
  /`([^`\n]+)`/.source, // 1 code
  /\*\*(.+?)\*\*/.source, // 2 bold
  /\[(?:(s\d{1,2})\s+)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[-–]\s*\d{1,2}:\d{2}(?::\d{2})?)?\]/.source, // 3 source, 4 time
  /\[sec:\s*([^\]]+)\]/.source, // 5 section
  /\[([^\]\n]+)\]\(([^)\s]+)\)/.source, // 6, 7 link
  /(?<![\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/.source, // 8 italic
  /(?<![\w_])_(?![\s_])([^_\n]+?)_(?![\w_])/.source, // 9 italic
  /\((added)\)/.source, // 10 added
  /(https?:\/\/[^\s)<>\]]+[^\s)<>\].,;:!?'"])/.source, // 11 bare url
].join('|'), 'g');

/** `ctx`: `{ videoId, videos: { s4: videoId }, sectionLinks: { heading: url } }`. */
export function parseInline(text, ctx = {}, style = {}) {
  const out = [];
  let last = 0;
  const push = item => {
    const merged = { ...style, ...item };
    for (const key of Object.keys(merged)) if (merged[key] === undefined || merged[key] === false) delete merged[key];
    out.push(merged);
  };
  for (const match of String(text).matchAll(INLINE)) {
    if (match.index > last) push({ s: text.slice(last, match.index) });
    last = match.index + match[0].length;
    if (match[1] !== undefined) push({ s: match[1], code: 1 });
    else if (match[2] !== undefined) out.push(...parseInline(match[2], ctx, { ...style, b: 1 }));
    else if (match[4] !== undefined) {
      const seconds = parseTime(match[4]);
      const video = (match[3] && ctx.videos?.[match[3]]) || ctx.videoId;
      if (video && Number.isFinite(seconds)) push({ s: match[4], time: 1, link: watchUrl(video, seconds) });
      else push({ s: match[0] });
    } else if (match[5] !== undefined) {
      const heading = match[5].trim();
      const link = ctx.sectionLinks?.[heading];
      push(link ? { s: heading, link, sec: 1 } : { s: heading, sec: 1 });
    } else if (match[6] !== undefined) {
      const url = match[7];
      if (/^https?:\/\//.test(url)) out.push(...parseInline(match[6], ctx, { ...style, link: url }));
      else push({ s: match[6] });
    } else if (match[8] !== undefined || match[9] !== undefined) out.push(...parseInline(match[8] ?? match[9], ctx, { ...style, i: 1 }));
    else if (match[10] !== undefined) push({ s: '(added)', added: 1 });
    else if (match[11] !== undefined) push({ s: match[11], link: match[11] });
  }
  if (last < String(text).length) push({ s: String(text).slice(last) });
  // Neighbours with the same style join up.
  const joined = [];
  for (const item of out) {
    const prev = joined.at(-1);
    const { s: prevText, ...prevStyle } = prev || {};
    const { s: text2, ...itemStyle } = item;
    if (prev && JSON.stringify(prevStyle) === JSON.stringify(itemStyle) && !item.link) prev.s = prevText + text2;
    else joined.push({ ...item });
  }
  return joined;
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const isBlockStart = (line, next) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || LIST.test(line) || QUOTE.test(line) || (line.includes('|') && next !== undefined && TABLE_RULE.test(next));

const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());

export function markdownToBlocks(markdown, ctx = {}) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ t: 'code', lang: fence[2] || '', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: 'h', level: heading[1].length, inlines: parseInline(heading[2], ctx) });
      i++;
      continue;
    }
    if (RULE.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }
    if (line.includes('|') && lines[i + 1] !== undefined && TABLE_RULE.test(lines[i + 1])) {
      const rows = [cells(line).map(cell => parseInline(cell, ctx))];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]).map(cell => parseInline(cell, ctx)));
      blocks.push({ t: 'table', rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
      blocks.push({ t: 'quote', inlines: parseInline(body.join(' ').trim(), ctx) });
      continue;
    }
    const list = LIST.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const items = [];
      while (i < lines.length) {
        const item = LIST.exec(lines[i]);
        // A top-level marker of the other kind starts a new list.
        if (item && items.length && !item[1] && /\d/.test(item[2]) !== ordered) break;
        if (item) {
          items.push({ depth: Math.min(3, Math.floor(item[1].replace(/\t/g, '  ').length / 2)), ordered: /\d/.test(item[2]), text: item[3] });
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items.at(-1).text += ` ${lines[i++].trim()}`;
        } else if (!lines[i].trim()) {
          // A blank line inside a list: it goes on when the next text is another of its items.
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          const next = LIST.exec(lines[j] || '');
          if (!next || (!next[1] && /\d/.test(next[2]) !== ordered)) break;
          i = j;
        } else break;
      }
      blocks.push({
        t: ordered ? 'ol' : 'ul',
        start: ordered ? parseInt(list[2], 10) || 1 : 1,
        items: items.map(item => ({ depth: item.depth, ordered: item.ordered, inlines: parseInline(item.text, ctx) })),
      });
      continue;
    }
    const body = [];
    while (i < lines.length && lines[i].trim() && !(body.length && isBlockStart(lines[i], lines[i + 1]))) body.push(lines[i++].trim());
    blocks.push({ t: 'p', inlines: parseInline(body.join(' '), ctx) });
  }
  return blocks;
}

/** Plain text of some inlines (for search and the chat's view of a page). */
export const inlineText = inlines => (inlines || []).map(item => item.s).join('');
