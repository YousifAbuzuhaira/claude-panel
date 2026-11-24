// What looks like a secret, hidden before text goes anywhere: the model, a clip, the screen, a file
// someone passes on. Hiding too much is always the safer mistake.
//   maskSecrets(text)      any text: chats, config, scripts, logs
//   maskCode(text, ext)    a whole source file, where an unquoted value is code and not a secret
// Neither ever changes the number of lines, so an excerpt's lines stay the file's lines.

const HIDDEN = '<hidden>';

// A name that says its value is secret. "author" and "authority" are not; "authorization" is.
const WORD = '(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIALS?|AUTH(?!OR(?!I[ZS])))';
// Bounded, so a long unbroken line can't take forever.
const NAME = `[A-Za-z0-9_]{0,80}${WORD}[A-Za-z0-9_]{0,80}`;

// Secrets known by their own shape, wherever they are.
const SHAPES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, found => found.replace(/[^\n]+/g, '<hidden private key>')],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, HIDDEN],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, HIDDEN],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, HIDDEN],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, HIDDEN],
  [/\bAKIA[0-9A-Z]{16}\b/g, HIDDEN],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, HIDDEN], // a JWT
  [/\b(kop|kwk|sbp|pk|rk|whsec)_[A-Za-z0-9]{20,}/g, HIDDEN],
  [/\bkop\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})*/g, HIDDEN],
  // A password in a URL: scheme://user:secret@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, `$1${HIDDEN}@`],
  // A credential sent in a header. A word ("Bearer authentication") is not one.
  [/\b(Bearer|Basic)([ \t]+)(?:(?=[^\s"'`]*[0-9])[A-Za-z0-9._~+/=-]{6,}|[A-Za-z0-9._~+/=-]{20,})/gi, `$1$2${HIDDEN}`],
];

const NAMED = [
  // NAME=value and NAME: value, quoted or not (.env files, exports, YAML).
  [new RegExp(String.raw`\b(${NAME})(\s*[=:]\s*)(["']?)(?!<hidden|(?:Bearer|Basic)\s)[^\s"'\`,;]{6,}\3`, 'gi'), `$1$2$3${HIDDEN}$3`],
  // The same with a quoted name ("DB_PASSWORD": "..."), or a quoted value with spaces in it.
  [new RegExp(String.raw`\b(${NAME}["']?\]?\s*[=:]\s*)(["'])(?!<hidden)[^"'\n]{6,}\2`, 'gi'), `$1$2${HIDDEN}$2`],
  // "password": "..." in JSON, however short.
  [/("(?:password|passwd|secret|token|api_?key|access_?token|refresh_?token|client_?secret|private_?key)"\s*:\s*")[^"\n]{4,}(")/gi, `$1${HIDDEN}$2`],
];

const replaceAll = (text, patterns) => patterns.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), String(text));

/** Text with what looks like a secret (keys, tokens, passwords, .env values) replaced by <hidden>. */
export const maskSecrets = text => replaceAll(replaceAll(text, SHAPES), NAMED);

// --- Source files -----------------------------------------------------------------------------

// Languages where a value with no quotes is code. Any other file keeps maskSecrets' rule.
const SLASHES = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.go', '.java', '.kt', '.cs', '.rs', '.swift', '.c', '.h', '.cpp', '.hpp'];
const HASHES = ['.py'];

// Words that start an expression or name a type without being declared in the file.
const KNOWN = new Set('string number boolean unknown any void null undefined true false never bigint symbol object this super await async new typeof function keyof readonly import process crypto console window document globalThis JSON Math Object Array String Number Boolean Buffer Promise Record Partial Pick Omit Readonly ReadonlySet ReadonlyMap ReadonlyArray Required Awaited ReturnType Parameters Extract Exclude NonNullable WeakMap Map Set Date URL URLSearchParams Response Request Headers React None True False self cls str int bytes bool float dict list tuple lambda not nil byte error rune struct interface map chan func uint8 int64 final var char'.split(' '));

/** The string literals of one line, and where its comment starts (its length when it has none). */
function lineParts(line, hash) {
  const literals = [];
  if (/^\s*(?:\*|\/\*)/.test(line)) return { literals, comment: 0 };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' || c === "'" || c === '`') {
      let end = i + 1;
      while (end < line.length && line[end] !== c) end += line[end] === '\\' ? 2 : 1;
      literals.push({ from: i + 1, to: Math.min(end, line.length), quote: c, closed: end < line.length });
      i = end;
    } else if (hash ? c === '#' : (c === '/' && (line[i + 1] === '/' || line[i + 1] === '*'))) return { literals, comment: i };
  }
  return { literals, comment: line.length };
}

/**
 * Whether an unquoted value is plainly code: a call, a regular expression, or a word the rest of the
 * file uses too. In doubt it isn't: the line may be text inside quotes that opened lines above.
 */
function isCode(value, uses) {
  if (/^\/[^/].*[\\^$[(]/.test(value)) return true; // a regular expression
  const opened = /^(?:\.\.\.|[([{!~&*<+|-])+/.exec(value)?.[0] || '';
  const bare = value.slice(opened.length);
  if (!bare) return true; // brackets and signs only
  const head = /^[A-Za-z_$][\w$]*/.exec(bare)?.[0];
  if (!head) return false;
  const rest = bare.slice(head.length);
  if (/^[-/@#%~\\^]/.test(rest)) return false;
  if (KNOWN.has(head) || /^(?:\??\.[A-Za-z_$][\w$]*)*(?:\?\.)?\(/.test(rest)) return true;
  if (opened.includes('(') && /^\??:/.test(rest)) return true; // a function's first parameter
  // A word on its own: no digits (a password has them more often), unless it's a constant's name.
  const isAlone = !/^(?:\??\.[A-Za-z_$]|\[|<[A-Za-z])/.test(rest);
  if (isAlone && /[0-9]/.test(head) && !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(head)) return false;
  return (uses.get(head) || 0) > 1;
}

/** Whether a quoted value that only shares a line with a secret name could be one: it has a digit, or is long and unbroken. */
const couldBeSecret = text => (/[0-9]/.test(text) && !NOT_SECRET.test(text)) || /^[A-Za-z+/=]{20,}$/.test(text);
// A path of words, or an algorithm's or an encoding's name.
const NOT_SECRET = /^(?:\/[a-z/_:-]*(?:v[0-9])?[a-z/_:-]*|base64(?:url)?|utf-?8|oauth2|(?:sha|md|hs|rs|es|ps)-?[0-9]{1,3}|aes-[0-9]{3}-[a-z]{3})$/i;

const UNQUOTED = new RegExp(String.raw`\b(${NAME})(\s*[=:]\s*)(?!<hidden|(?:Bearer|Basic)\b)([^\s"'\`,;]{6,})`, 'gi');
const HAS_NAME = new RegExp(WORD, 'i');
// What a quoted value is set to, compared with, or passed beside ("Authorization", "..."): the name, then it.
const ASSIGNED = new RegExp(String.raw`\b(${NAME})(?:["'\`]\s*,|["'\`]?[\])]?(?:\s*[?!]?:[^=,;(){}"'\`]*)?\s*(?:=>|:=|[!=]==?|[=:]|\|\||\?\?))\s*(?:(?:String::from|Buffer\.from|SecretStr|new [A-Za-z]{1,40})\(|["'][^"']{0,80}["']\s*\+\s*)?[@$frbu]{0,2}$`, 'i');
const MODULE = /(?:\bfrom|\bimport|\brequire\(|\bimport\()\s*$/;

/** One line of a source file. */
function maskLine(line, uses, hash) {
  if (!HAS_NAME.test(line)) return line;
  if (line.length > 2000) return replaceAll(line, NAMED); // minified: not worth reading as code
  const { literals, comment } = lineParts(line, hash);
  const isText = at => at >= comment || literals.some(literal => at >= literal.from && at < literal.to);
  const cuts = [];
  for (const literal of literals) {
    const text = line.slice(literal.from, literal.to);
    const before = line.slice(0, literal.from - 1);
    if (text.length < 6 || text.startsWith(HIDDEN) || MODULE.test(before) || !HAS_NAME.test(before)) continue;
    if (literal.quote === '`' && text.includes('${')) continue; // put together from variables
    const name = ASSIGNED.exec(before)?.[1];
    // Set to the name: hidden, unless it's the name again in capitals (an error code). Elsewhere on
    // the line: a sentence is a message, and words are words.
    if (name ? name === text && /^[A-Z_]+$/.test(text) : /\s/.test(text.trim()) || !couldBeSecret(text)) continue;
    cuts.push([literal.from, literal.to]);
  }
  for (const match of line.matchAll(UNQUOTED)) {
    const from = match.index + match[1].length + match[2].length;
    const value = match[3];
    if (cuts.some(([a, b]) => from < b && from + value.length > a)) continue;
    if (!isText(from)) {
      if (/^-?[0-9][0-9_]*\b/.test(value)) {
        // A number: a limit or a time, unless the name says it's a password or a key.
        if (value.replace(/[^0-9]/g, '').length < 6 || !/SECRET|PASS|PWD|KEY|CREDENTIAL/i.test(match[1])) continue;
      } else if (isCode(value, uses)) continue;
    }
    cuts.push([from, from + value.length]);
  }
  for (const [from, to] of cuts.sort((a, b) => b[0] - a[0])) line = line.slice(0, from) + HIDDEN + line.slice(to);
  return line;
}

/**
 * A whole source file with what looks like a secret hidden: every known shape; a quoted value on a
 * line after a secret name; and, in comments and inside quotes, maskSecrets' own rule. An unquoted
 * value that is plainly code (`token = mint(user)`, `token: string`) is shown.
 */
export function maskCode(text, ext) {
  const hash = HASHES.includes(ext);
  if (!hash && !SLASHES.includes(ext)) return maskSecrets(text);
  const uses = new Map();
  for (const [word] of String(text).matchAll(/[A-Za-z_$][\w$]*/g)) uses.set(word, (uses.get(word) || 0) + 1);
  return replaceAll(text, SHAPES).split('\n').map(line => maskLine(line, uses, hash)).join('\n');
}
