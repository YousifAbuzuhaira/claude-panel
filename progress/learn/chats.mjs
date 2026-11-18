// The learner's Claude Code chats, as a course's source. Claude Code keeps each chat as JSON
// lines in <config>/projects/<project>/<session>.jsonl (CLAUDE_CONFIG_DIR, else ~/.claude), with
// every message, compacted or not. Learn lists them, finds one by its id, and shrinks it to a
// text file a build's Claude run searches (Read and Grep only) for the part the course is about.
// Things that look like secrets are masked on the way. Pure parts exported for the tests.
import { closeSync, createReadStream, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESULT_CHARS = 1500;
const EDIT_CHARS = 400;
const TEXT_CHARS = 12_000;

// LEARN_CHATS_DIR points a scratch build at copies of chats; CLAUDE_CONFIG_DIR would move Claude's login too.
export const projectsDir = () => process.env.LEARN_CHATS_DIR || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

/** Claude Code's folder name for a working folder: every character not a letter or digit is a dash. */
export const projectSlug = path => String(path).replace(/[^A-Za-z0-9]/g, '-');

function readSlice(file, start, length) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const parseLines = text => text.split('\n').map(line => {
  try {
    return JSON.parse(line);
  } catch {
    return null; // the first and last lines of a slice are cut
  }
}).filter(Boolean);

/** The text of a message's content: a string, or the text blocks of an array. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block && block.type === 'text').map(block => block.text || '').join('\n');
}

const isNoise = text => !text.trim() || /^<(command-name|local-command-stdout|local-command-caveat|system-reminder)>/.test(text.trim());

/** What a chat is called: its own title (custom, then the one Claude gave it), else its first words. */
export function chatTitle(records) {
  let title = '';
  let ai = '';
  let first = '';
  for (const record of records) {
    if (record.type === 'custom-title' && record.customTitle) title = String(record.customTitle);
    if (record.type === 'ai-title' && (record.aiTitle || record.title)) ai = String(record.aiTitle || record.title);
    if (record.type === 'summary' && record.summary && !ai) ai = String(record.summary);
    if (!first && record.type === 'user' && !record.isMeta && !record.isSidechain) {
      const text = contentText(record.message?.content).replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
      if (!isNoise(text)) first = text.replace(/\s+/g, ' ');
    }
  }
  const chosen = title || ai || first || 'Untitled chat';
  return chosen.length > 80 ? `${chosen.slice(0, 79).trimEnd()}…` : chosen;
}

/**
 * The learner's chats, the one used last first: `{ id, title, project, cwd, at, size }`.
 * `exclude` holds working folders whose chats are Learn's own (its library).
 */
export function listClaudeChats({ exclude = [], limit = 40, dir = projectsDir() } = {}) {
  if (!existsSync(dir)) return [];
  const skip = new Set(exclude.map(projectSlug));
  const files = [];
  for (const project of readdirSync(dir)) {
    if (skip.has(project)) continue;
    let names;
    try {
      names = readdirSync(join(dir, project));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl') || !SESSION_ID.test(name.slice(0, -6))) continue;
      const file = join(dir, project, name);
      try {
        const stat = statSync(file);
        if (stat.isFile() && stat.size > 2000) files.push({ file, id: name.slice(0, -6), at: stat.mtimeMs, size: stat.size });
      } catch {
        // gone meanwhile
      }
    }
  }
  files.sort((p, q) => q.at - p.at);
  const chats = [];
  for (const item of files) {
    if (chats.length >= limit) break;
    // The head has the first words and the folder; the tail the newest title.
    const head = parseLines(readSlice(item.file, 0, Math.min(item.size, 96 * 1024)));
    const tail = item.size > 96 * 1024 ? parseLines(readSlice(item.file, Math.max(0, item.size - 256 * 1024), 256 * 1024)) : [];
    const records = [...head, ...tail];
    const cwd = records.find(record => typeof record.cwd === 'string')?.cwd || '';
    // A chat with nothing said in it (opened and left, or only commands) is not worth a course.
    if (!records.some(record => record.type === 'user' && !record.isMeta && !record.isSidechain && !isNoise(contentText(record.message?.content)))) continue;
    chats.push({ id: item.id, title: chatTitle(records), project: cwd ? basename(cwd) : '', cwd, at: new Date(item.at).toISOString(), size: item.size });
  }
  return chats;
}

/** A chat's file and working folder, by its id. */
export function findClaudeChat(id, { dir = projectsDir() } = {}) {
  if (!SESSION_ID.test(String(id || ''))) throw new Error('that is not a chat id');
  if (existsSync(dir)) {
    for (const project of readdirSync(dir)) {
      const file = join(dir, project, `${id}.jsonl`);
      if (existsSync(file)) {
        const head = parseLines(readSlice(file, 0, 96 * 1024));
        const cwd = head.find(record => typeof record.cwd === 'string')?.cwd || '';
        return { file, cwd, title: chatTitle([...head, ...parseLines(readSlice(file, Math.max(0, statSync(file).size - 256 * 1024), 256 * 1024))]) };
      }
    }
  }
  throw new Error('that chat is not on this computer any more');
}

// --- Secrets --------------------------------------------------------------------------------

const HIDDEN = '<hidden>';
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<hidden private key>'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, HIDDEN],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, HIDDEN],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, HIDDEN],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, HIDDEN],
  [/\bAKIA[0-9A-Z]{16}\b/g, HIDDEN],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, HIDDEN], // a JWT
  [/\b(kop|sbp|pk|rk|whsec)_[A-Za-z0-9]{20,}/g, HIDDEN],
  // A password in a URL: scheme://user:secret@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, `$1${HIDDEN}@`],
  // NAME=value and NAME: value where the name says it is secret (.env files, exports, YAML)
  [/\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)(?!<hidden)[^\s"'`,;]{6,}\3/gi, `$1$2$3${HIDDEN}$3`],
  // "password": "..." in JSON
  [/("(?:password|passwd|secret|token|api_?key|access_?token|refresh_?token|client_?secret|private_?key)"\s*:\s*")[^"]{4,}(")/gi, `$1${HIDDEN}$2`],
];

/** Text with what looks like a secret (keys, tokens, passwords, .env values) replaced by <hidden>. */
export function maskSecrets(text) {
  let out = String(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// --- Shrinking a chat to text -------------------------------------------------------------------

const cut = (text, max) => {
  const flat = String(text ?? '');
  return flat.length > max ? `${flat.slice(0, max)} [... ${flat.length - max} more characters]` : flat;
};

function toolLine(block) {
  const input = block.input || {};
  switch (block.name) {
    case 'Bash': return `tool Bash: ${cut(input.command, 600)}`;
    case 'Read': return `tool Read: ${input.file_path || ''}${input.offset ? ` from line ${input.offset}` : ''}`;
    case 'Write': return `tool Write: ${input.file_path || ''} (${String(input.content || '').split('\n').length} lines)\n${cut(input.content, EDIT_CHARS)}`;
    case 'Edit': return `tool Edit: ${input.file_path || ''}\n  was: ${cut(input.old_string, EDIT_CHARS)}\n  now: ${cut(input.new_string, EDIT_CHARS)}`;
    case 'Grep': return `tool Grep: ${input.pattern || ''}${input.path ? ` in ${input.path}` : ''}`;
    case 'Glob': return `tool Glob: ${input.pattern || ''}`;
    default: return `tool ${block.name}: ${cut(JSON.stringify(input), 300)}`;
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => (block && block.type === 'text' ? block.text : block && block.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

/**
 * A chat's records as plain text, oldest first: each turn's words, a line per tool call,
 * edits as short before/after, results cut short, and where it was compacted. Masked.
 */
export function condenseChat(jsonl, { title = '' } = {}) {
  const writer = condenser(title);
  for (const record of parseLines(String(jsonl))) writer.add(record);
  return writer.text();
}

function condenser(title) {
  const out = [];
  if (title) out.push(`CHAT: ${title}`, '');
  let turn = 0;
  const add = record => {
    if (record.isSidechain) return; // a subagent's own work
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      out.push('', '--- The chat was compacted here: Claude went on from a summary, but this record keeps everything. ---', '');
      return;
    }
    if (record.type !== 'user' && record.type !== 'assistant') return;
    const content = record.message?.content;
    const at = typeof record.timestamp === 'string' ? record.timestamp.slice(0, 16).replace('T', ' ') : '';
    if (record.type === 'user') {
      if (record.isCompactSummary) {
        out.push(`[summary written at the compaction] ${cut(contentText(content), TEXT_CHARS)}`, '');
        return;
      }
      if (Array.isArray(content) && content.some(block => block && block.type === 'tool_result')) {
        for (const block of content.filter(item => item && item.type === 'tool_result')) {
          const text = resultText(block.content).trim();
          if (text) out.push(`  result${block.is_error ? ' (error)' : ''}: ${cut(text, RESULT_CHARS)}`);
        }
        return;
      }
      if (record.isMeta) return;
      const text = contentText(content).trim();
      if (isNoise(text)) return;
      turn++;
      out.push('', `[#${turn} ${at}] LEARNER: ${cut(text, TEXT_CHARS)}`);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block) continue;
      if (block.type === 'text' && block.text && block.text.trim()) out.push(`CLAUDE: ${cut(block.text.trim(), TEXT_CHARS)}`);
      else if (block.type === 'tool_use') out.push(`  ${toolLine(block)}`);
    }
  };
  return { add, text: () => maskSecrets(out.join('\n')), turns: () => turn };
}

/** The chat by id, shrunk, read a line at a time (a long chat's record runs to hundreds of MB): `{ text, cwd, title, turns }`. */
export async function readClaudeChat(id, options = {}) {
  const found = findClaudeChat(id, options);
  const writer = condenser(found.title);
  const lines = createInterface({ input: createReadStream(found.file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    writer.add(record);
  }
  return { text: writer.text(), cwd: found.cwd, title: found.title, turns: writer.turns() };
}
