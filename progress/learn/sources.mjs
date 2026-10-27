// Reading the sources a course is built from: YouTube through yt-dlp (search, chapters,
// captions), and open web pages turned into sections. Parsing is pure and exported for
// the tests; the rest shells out or fetches.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureYtDlp } from './deps.mjs';

// --- Time --------------------------------------------------------------------------

export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** `1:02:03`, `62:03` or `75` to seconds; NaN when it isn't a time. */
export function parseTime(text) {
  const parts = String(text).trim().split(':');
  if (parts.length > 3 || parts.some(part => !/^\d{1,3}$/.test(part))) return NaN;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

// --- YouTube urls ---------------------------------------------------------------------

export function youTubeId(url) {
  const text = String(url);
  const match = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(text);
  return match ? match[1] : null;
}

/** A playlist link: `/playlist?list=`, or a `list=` without a video to start on. */
export function isPlaylist(url) {
  const text = String(url);
  return /youtube\.com\/playlist\?/.test(text) || (/[?&]list=[\w-]+/.test(text) && !/[?&]v=[\w-]{11}/.test(text));
}

export const isYouTube = url => /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//.test(String(url));

export const watchUrl = (id, seconds) => `https://www.youtube.com/watch?v=${id}${seconds > 0 ? `&t=${Math.floor(seconds)}s` : ''}`;

// --- Captions --------------------------------------------------------------------------

/** yt-dlp's json3 captions as `[{ t, text }]`, one entry per caption line. */
export function parseJson3(text) {
  const data = typeof text === 'string' ? JSON.parse(text) : text;
  const lines = [];
  for (const event of data.events || []) {
    if (!event.segs) continue;
    const words = event.segs.map(seg => seg.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!words || words === '[Music]') continue;
    const t = Math.floor((event.tStartMs || 0) / 1000);
    const last = lines.at(-1);
    // Auto-captions repeat the line being built; keep the fuller one.
    if (last && (words.startsWith(last.text) || last.text.endsWith(words))) {
      if (words.length > last.text.length) last.text = words;
      continue;
    }
    lines.push({ t, text: words });
  }
  return lines;
}

/** Caption lines joined into chunks of about `seconds`, each starting at its first line. */
export function chunkLines(lines, seconds = 30) {
  const chunks = [];
  for (const line of lines) {
    const last = chunks.at(-1);
    if (last && line.t - last.t < seconds) last.text += ` ${line.text}`;
    else chunks.push({ t: line.t, text: line.text });
  }
  return chunks;
}

/** The transcript between two times as `[mm:ss] text` lines, for a prompt. */
export function transcriptText(chunks, from = 0, to = Infinity) {
  return chunks.filter(chunk => chunk.t >= from - 1 && chunk.t < to).map(chunk => `[${formatTime(chunk.t)}] ${chunk.text}`).join('\n');
}

/** An evenly spread sample of a transcript that fits `maxChars`, for the outline. */
export function condenseTranscript(chunks, maxChars) {
  const full = transcriptText(chunks);
  if (full.length <= maxChars) return full;
  const keep = Math.max(1, Math.floor(chunks.length * (maxChars / full.length)));
  const step = chunks.length / keep;
  const picked = [];
  for (let i = 0; i < keep; i++) picked.push(chunks[Math.floor(i * step)]);
  return transcriptText(picked).slice(0, maxChars);
}

// --- yt-dlp -----------------------------------------------------------------------------

function run(binary, args, timeoutMs = 120_000) {
  return new Promise(resolve => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), code: error?.code ?? 0 });
    });
  });
}

async function ytDlp(args, timeoutMs) {
  const binary = await ensureYtDlp();
  // Recent yt-dlp needs a JavaScript runtime for YouTube; Node is already here.
  return run(binary, ['--ignore-config', '--no-warnings', '--no-progress', '--js-runtimes', `node:${process.execPath}`, ...args], timeoutMs);
}

const errorLine = result => (result.stderr.split('\n').filter(line => /ERROR/.test(line)).pop() || result.stderr.trim().split('\n').pop() || 'yt-dlp failed').replace(/^ERROR:\s*/, '').slice(0, 300);

/** Whether a failure looks like YouTube changed under us (worth a yt-dlp refresh). */
export const isExtractorError = message => /extractor|unable to extract|signature|nsig|player|update yt-dlp|HTTP Error 403/i.test(message);

export async function ytSearch(query, count = 8) {
  const result = await ytDlp(['--flat-playlist', '-J', `ytsearch${count}:${query}`]);
  if (!result.ok) throw new Error(errorLine(result));
  return (JSON.parse(result.stdout).entries || []).filter(entry => entry && entry.id).map(entry => ({
    kind: 'youtube',
    url: watchUrl(entry.id),
    title: entry.title || entry.id,
    channel: entry.channel || entry.uploader || '',
    lengthMin: entry.duration ? Math.round(entry.duration / 60) : null,
    views: entry.view_count || null,
  }));
}

/** A playlist's videos, in order. */
export async function ytPlaylist(url) {
  const result = await ytDlp(['--flat-playlist', '-J', url]);
  if (!result.ok) throw new Error(errorLine(result));
  const data = JSON.parse(result.stdout);
  return {
    title: data.title || 'Playlist',
    videos: (data.entries || []).filter(entry => entry && entry.id).map(entry => ({
      kind: 'youtube',
      url: watchUrl(entry.id),
      title: entry.title || entry.id,
      channel: entry.channel || data.channel || '',
      lengthMin: entry.duration ? Math.round(entry.duration / 60) : null,
    })),
  };
}

/** Title, channel, length and chapters of one video. */
export async function ytInfo(url) {
  const result = await ytDlp(['-J', '--skip-download', '--ignore-no-formats-error', url]);
  if (!result.ok) throw new Error(errorLine(result));
  const data = JSON.parse(result.stdout);
  return {
    id: data.id,
    title: data.title,
    channel: data.channel || data.uploader || '',
    durationSec: data.duration || 0,
    chapters: (data.chapters || []).map(chapter => ({ title: chapter.title, start: Math.floor(chapter.start_time), end: Math.floor(chapter.end_time) })),
    description: String(data.description || '').slice(0, 4000),
  };
}

// Manual English first, then the auto-generated original.
const CAPTION_LANGS = ['en', 'en-US', 'en-GB', 'en-orig'];

/** `{ chunks }` or `{ chunks: null, reason }`. */
export async function ytCaptions(id, dir) {
  mkdirSync(dir, { recursive: true });
  const result = await ytDlp([
    '--skip-download', '--write-subs', '--write-auto-subs',
    '--sub-langs', CAPTION_LANGS.join(','), '--sub-format', 'json3',
    '-o', join(dir, '%(id)s.%(ext)s'), watchUrl(id),
  ], 180_000);
  const files = readdirSync(dir).filter(name => name.startsWith(`${id}.`) && name.endsWith('.json3'));
  const pick = CAPTION_LANGS.map(lang => `${id}.${lang}.json3`).find(name => files.includes(name)) || files[0];
  if (!pick) return { chunks: null, reason: result.ok ? 'the video has no English captions' : errorLine(result) };
  const lines = parseJson3(readFileSync(join(dir, pick), 'utf8'));
  if (lines.length < 5) return { chunks: null, reason: 'the captions are empty' };
  return { chunks: chunkLines(lines, 30) };
}

// --- Web pages ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '-', ndash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: '(c)' };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const stripTags = html => decodeEntities(html.replace(/<[^>]+>/g, ''));
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A page as `{ title, sections: [{ heading, anchor, level, text }] }`. Code keeps its fences. */
export function htmlToSections(html) {
  let body = String(html).replace(/<!--[\s\S]*?-->/g, '');
  const title = stripTags((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body) || [])[1] || '').trim();
  body = body.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|button|template)\b[\s\S]*?<\/\1>/gi, '');
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1>/i.exec(body);
  if (main) body = main[2];
  const blocks = [];
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (whole, inner) => {
    blocks.push(stripTags(inner.replace(/<br\s*\/?>/gi, '\n')).replace(/\n+$/, ''));
    return `\n\u0001${blocks.length - 1}\u0001\n`;
  });
  body = body
    .replace(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (whole, level, attrs, inner) => {
      const id = (/\bid="([^"]+)"/.exec(attrs) || /\b(?:id|name)="([^"]+)"/.exec(inner) || [])[1] || '';
      const text = stripTags(inner).replace(/\s+/g, ' ').trim();
      return `\n\u0002${level}|${id}|${text}\n`;
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (whole, inner) => `\`${stripTags(inner)}\``)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|section|table|ul|ol|dd|dt|blockquote)>/gi, '\n');
  const text = stripTags(body);
  const sections = [{ heading: title || 'Introduction', anchor: '', level: 1, lines: [] }];
  for (const raw of text.split('\n')) {
    const heading = /^\u0002(\d)\|([^|]*)\|(.*)$/.exec(raw.trim());
    if (heading) {
      sections.push({ heading: heading[3] || 'Section', anchor: heading[2] || slug(heading[3]), level: Number(heading[1]), lines: [] });
      continue;
    }
    const code = /^\u0001(\d+)\u0001$/.exec(raw.trim());
    if (code) {
      sections.at(-1).lines.push('```', blocks[Number(code[1])], '```');
      continue;
    }
    const line = raw.replace(/[ \t ]+/g, ' ').trim();
    if (line) sections.at(-1).lines.push(line);
  }
  return {
    title: title || sections[1]?.heading || '',
    sections: sections
      .map(section => ({ heading: section.heading, anchor: section.anchor, level: section.level, text: section.lines.join('\n').slice(0, 40_000) }))
      .filter((section, i) => section.text || i > 0),
  };
}

export async function fetchPage(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (claude-learn; personal study)', Accept: 'text/html,text/markdown,text/plain' },
    signal: AbortSignal.timeout(30_000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const type = response.headers.get('content-type') || '';
  const text = (await response.text()).slice(0, 3_000_000);
  if (/html/.test(type) || /^\s*</.test(text)) return htmlToSections(text);
  // Markdown or plain text: split on headings.
  const sections = [{ heading: 'Introduction', anchor: '', level: 1, lines: [] }];
  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) sections.push({ heading: heading[2].trim(), anchor: slug(heading[2]), level: heading[1].length, lines: [] });
    else sections.at(-1).lines.push(line);
  }
  return {
    title: sections[1]?.heading || url,
    sections: sections.map(section => ({ heading: section.heading, anchor: section.anchor, level: section.level, text: section.lines.join('\n').trim().slice(0, 40_000) })).filter(section => section.text),
  };
}

/** Sections as text for a prompt, each headed `[sec: Heading]`. */
export function sectionsText(sections, names = null, maxChars = 120_000) {
  const wanted = names ? sections.filter(section => names.includes(section.heading)) : sections;
  return wanted.map(section => `[sec: ${section.heading}]\n${section.text}`).join('\n\n').slice(0, maxChars);
}

/** Headings with the start of each section: the outline's view of a page. */
export const sectionsOutline = (sections, perSection = 400) => sections.map(section => `[sec: ${section.heading}] ${section.text.slice(0, perSection).replace(/\s+/g, ' ')}`).join('\n');
