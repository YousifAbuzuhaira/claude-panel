// The typing test's rules and scoring, ported from widget/TypeTest.ps1 (class
// TypeStats and the test functions around it). No DOM. Scored as Monkeytype scores.
import { nextInt } from '../rng.js';
import { WORD_LIST } from './words.js';

export { WORD_LIST };
export const WORD_COUNT = 10;
export const EXTRA_LIMIT = 10;
export const DEFAULT_THEME = 'serika_dark';
// bg, main, caret, sub, subAlt, text, error, errorExtra.
export const SERIKA_DARK = ['#323437', '#E2B714', '#E2B714', '#646669', '#2C2E31', '#D1D0C5', '#CA4754', '#7E2A33'];
export const THEME_KEYS = ['bg', 'main', 'caret', 'sub', 'subAlt', 'text', 'error', 'errorExtra'];

/** WORD_COUNT words; a word never repeats either of the two before it, as Monkeytype picks. */
export function pickWords(rng = Math.random, list = WORD_LIST, count = WORD_COUNT) {
  const picked = [];
  while (picked.length < count) {
    const word = list[nextInt(rng, list.length)];
    if (picked.length >= 1 && picked[picked.length - 1] === word) continue;
    if (picked.length >= 2 && picked[picked.length - 2] === word) continue;
    picked.push(word);
  }
  return picked;
}

// --- TypeStats: Monkeytype's arithmetic -------------------------------------------------

/**
 * Words before `submitted` were ended with a space (no space follows the test's
 * last word); the word at `submitted` is the one being typed. With countPartial, a
 * right start of that word counts toward wpm, as the live per-second wpm does.
 */
export function count(targets, inputs, submitted, countPartial) {
  const c = { correctWordChars: 0, correctChars: 0, incorrectChars: 0, extraChars: 0, missedChars: 0, correctSpaces: 0, allSpaces: 0 };
  for (let i = 0; i < targets.length && i <= submitted; i++) {
    const target = targets[i];
    const typed = inputs[i] ?? '';
    const isSubmitted = i < submitted;
    if (!isSubmitted && typed.length === 0) break;
    const isRight = typed === target;
    if (isRight) {
      c.correctWordChars += target.length;
      c.correctChars += target.length;
    } else {
      for (let j = 0; j < typed.length; j++) {
        if (j >= target.length) c.extraChars++;
        else if (typed[j] === target[j]) c.correctChars++;
        else c.incorrectChars++;
      }
      if (isSubmitted) c.missedChars += Math.max(0, target.length - typed.length);
      else if (countPartial && target.startsWith(typed)) c.correctWordChars += typed.length;
    }
    if (isSubmitted && i < targets.length - 1) {
      c.allSpaces++;
      if (isRight) c.correctSpaces++;
    }
  }
  return c;
}

/** Letters of correct words plus their spaces, as 5-letter words per minute. */
export const wpm = (c, seconds) => (seconds <= 0 ? 0 : ((c.correctWordChars + c.correctSpaces) * 60) / seconds / 5);

/** Every letter and space typed, as 5-letter words per minute. */
export const raw = (c, seconds) =>
  seconds <= 0 ? 0 : ((c.correctChars + c.incorrectChars + c.extraChars + c.allSpaces) * 60) / seconds / 5;

export const kogasa = cov => 100 * (1 - Math.tanh(cov + cov ** 3 / 3 + cov ** 5 / 5));

/** How even the per-second raw speeds were: 100 when every second was alike. */
export function consistency(raws) {
  if (!raws || raws.length === 0) return 0;
  const mean = raws.reduce((sum, v) => sum + v, 0) / raws.length;
  if (mean <= 0) return 0;
  const squares = raws.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  return kogasa(Math.sqrt(squares / raws.length) / mean);
}

// --- One test ----------------------------------------------------------------------------

/**
 * One test, driven by its page. `now()` is in milliseconds. The page calls
 * addSample(1) once a second while `isStarted && !isFinished`; addLetter and
 * removeLetter return what happened so the page knows what to redraw.
 */
export class TypeTest {
  constructor({ rng = Math.random, now = () => performance.now(), targets } = {}) {
    this.now = now;
    this.targets = targets ?? pickWords(rng);
    this.typed = this.targets.map(() => '');
    this.current = 0;
    this.isStarted = false;
    this.isFinished = false;
    this.startedAt = 0;
    this.endedAt = 0;
    this.keyCount = 0;
    this.goodKeys = 0;
    this.secondChars = 0;
    this.secondErrors = 0;
    this.samples = [];
    this.result = null;
  }

  seconds() {
    if (!this.isStarted) return 0;
    return ((this.isFinished ? this.endedAt : this.now()) - this.startedAt) / 1000;
  }

  start() {
    this.isStarted = true;
    this.startedAt = this.now();
  }

  keypress(isRight) {
    this.keyCount++;
    this.secondChars++;
    if (isRight) this.goodKeys++;
    else this.secondErrors++;
  }

  /** Each second: the wpm so far, the raw speed of that second, and its errors. */
  addSample(span = 1) {
    const tally = count(this.targets, this.typed, this.current, true);
    this.samples.push({ wpm: wpm(tally, this.seconds()), raw: (this.secondChars * 60) / 5 / span, errors: this.secondErrors });
    this.secondChars = 0;
    this.secondErrors = 0;
  }

  /** One typed character. Comparison is case-sensitive. */
  addLetter(ch) {
    if (this.isFinished) return false;
    if (ch === ' ') return this.submitWord();
    if (!this.isStarted) this.start();
    const i = this.current;
    const target = this.targets[i];
    const typed = this.typed[i];
    if (typed.length >= target.length + EXTRA_LIMIT) return false;
    this.keypress(typed.length < target.length && target[typed.length] === ch);
    this.typed[i] = typed + ch;
    // The last word typed right ends the test: no space needed.
    if (i === this.targets.length - 1 && this.typed[i] === target) this.complete();
    return true;
  }

  /** Space ends a word; at a word's start it does nothing. */
  submitWord() {
    const i = this.current;
    const typed = this.typed[i];
    if (typed.length === 0) return false;
    this.keypress(typed === this.targets[i]);
    this.current++;
    if (this.current >= this.targets.length) this.complete();
    return true;
  }

  /**
   * Backspace takes a letter; at a word's start it goes back into the word
   * before, only when that word was left wrong. `word` (Ctrl+Backspace) takes the whole word.
   */
  removeLetter(word = false) {
    if (this.isFinished || !this.isStarted) return false;
    let i = this.current;
    if (this.typed[i].length === 0) {
      if (i === 0 || this.typed[i - 1] === this.targets[i - 1]) return false;
      this.current--;
      i = this.current;
      if (word) this.typed[i] = '';
    } else if (word) {
      this.typed[i] = '';
    } else {
      this.typed[i] = this.typed[i].slice(0, -1);
    }
    return true;
  }

  /** Is this word left behind wrong (underlined red)? */
  isLeftWrong(i) {
    return i < this.current && this.typed[i] !== this.targets[i];
  }

  complete() {
    this.endedAt = this.now();
    const seconds = (this.endedAt - this.startedAt) / 1000;
    // The last part-second joins the graph, scaled to a whole second.
    const part = seconds - this.samples.length;
    this.isFinished = true;
    if (part > 0.05 || this.samples.length === 0) this.addSample(Math.max(0.05, part));
    const tally = count(this.targets, this.typed, this.current, false);
    const acc = this.keyCount > 0 ? (100 * this.goodKeys) / this.keyCount : 0;
    this.result = {
      wpm: wpm(tally, seconds),
      raw: raw(tally, seconds),
      acc,
      goodKeys: this.goodKeys,
      badKeys: this.keyCount - this.goodKeys,
      chars: [tally.correctChars + tally.correctSpaces, tally.incorrectChars, tally.extraChars, tally.missedChars],
      consistency: consistency(this.samples.map(s => s.raw)),
      seconds,
      samples: this.samples,
    };
    return this.result;
  }
}

/** A result beats the best when it is faster and not all wrong. */
export const isBest = (result, best) => result.wpm > best && result.acc > 0;

// --- The graph's scale --------------------------------------------------------------------

/** The y axis top and its step, as the WPF graph picks them. */
export function graphScale(samples) {
  let top = 10;
  for (const s of samples) top = Math.max(top, s.wpm, s.raw);
  let step = 20;
  if (top > 120) step = 40;
  if (top > 240) step = 80;
  return { top: Math.ceil(top / step) * step, step };
}

// --- Themes: name|bg|main|caret|sub|subAlt|text|error|errorExtra ----------------------------

/** A WPF colour (#RRGGBB or #AARRGGBB) as CSS (#RRGGBB or #RRGGBBAA). */
export function cssColor(hex) {
  const value = String(hex).trim();
  if (/^#[0-9a-f]{8}$/i.test(value)) return `#${value.slice(3)}${value.slice(1, 3)}`;
  return value;
}

const COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The themes file as [{name, colors[8]}] in file order, colours in CSS order; serika_dark always there. */
export function parseThemes(text) {
  const themes = [];
  const seen = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('|');
    if (fields.length !== 9 || seen.has(fields[0])) continue;
    const colors = fields.slice(1);
    if (!colors.every(c => COLOR.test(c))) continue;
    seen.add(fields[0]);
    themes.push({ name: fields[0], colors: colors.map(cssColor) });
  }
  if (!seen.has(DEFAULT_THEME)) themes.push({ name: DEFAULT_THEME, colors: [...SERIKA_DARK] });
  return themes;
}

export const themeTitle = name => name.replaceAll('_', ' ');

/** The themes whose name has the query (spaces and underscores alike, any case). */
export function filterThemes(themes, query) {
  const q = String(query ?? '').trim().toLowerCase().replaceAll('_', ' ');
  return q ? themes.filter(t => themeTitle(t.name).toLowerCase().includes(q)) : themes;
}

// --- The save: {pb, theme} -------------------------------------------------------------------

/** The save file, each part checked on its own. `themes` (names) checks the theme when given. */
export function readSave(raw, themeNames) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const pb = typeof value.pb === 'number' && Number.isFinite(value.pb) && value.pb > 0 ? value.pb : 0;
  let theme = typeof value.theme === 'string' && value.theme ? value.theme : DEFAULT_THEME;
  if (themeNames && !themeNames.includes(theme)) theme = DEFAULT_THEME;
  return { pb, theme };
}

export const saveOf = (pb, theme) => ({ pb: Math.round(pb * 100) / 100, theme });
