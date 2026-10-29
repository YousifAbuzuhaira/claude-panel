// The typing test: Monkeytype's scoring (the WPF self-test's cases), input rules,
// words, themes ('auto', the colour scheme, among them) and the save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AUTO_THEME, DEFAULT_THEME, EXTRA_LIMIT, FALLBACK_THEME, SAVE_THEME_SET, TypeTest, WORD_COUNT, WORD_LIST, consistency, count, cssColor,
  filterThemes, graphScale, isBest, kogasa, parseThemes, pickWords, raw, readSave, saveOf, schemeAsTheme, schemeName,
  schemeProperties, themeTitle, withAlpha, wpm,
} from '../public/games/typing/logic.js';
import { seeded } from '../public/games/rng.js';

await import('../public/shared/theme.js');
const Theme = globalThis.ClaudeTheme;

const near = (value, expected) => assert.ok(Math.abs(value - expected) < 0.001, `${value} vs ${expected}`);

test('two words right in 6 s: 5 characters, 10 wpm', () => {
  const c = count(['ab', 'cd'], ['ab', 'cd'], 1, false);
  assert.equal(c.correctWordChars, 4);
  assert.equal(c.correctSpaces, 1);
  assert.equal(c.allSpaces, 1);
  near(wpm(c, 6), 10);
});

test('a wrong word gives no wpm; its right letters still count raw', () => {
  const c = count(['ab', 'cd'], ['ax', 'cd'], 1, false);
  assert.equal(c.correctWordChars, 2);
  assert.equal(c.correctSpaces, 0);
  assert.equal(c.correctChars, 3);
  assert.equal(c.incorrectChars, 1);
  near(raw(c, 6), 10);
});

test('extra and missed letters; the last word adds no space; live counts a right start', () => {
  const extra = count(['ab', 'c'], ['abz', 'c'], 1, false);
  assert.equal(extra.extraChars, 1);
  assert.equal(extra.correctChars, 3);
  assert.equal(count(['abc', 'd'], ['a', 'd'], 1, false).missedChars, 2);
  const ended = count(['ab', 'cd'], ['ab', 'c'], 2, false);
  assert.equal(ended.allSpaces, 1);
  assert.equal(ended.missedChars, 1);
  assert.equal(count(['ab', 'cd'], ['ab', 'c'], 1, true).correctWordChars, 3);
  assert.equal(count(['ab', 'cd'], ['ab', 'C'], 1, true).correctWordChars, 2, 'case-sensitive');
});

test('consistency: kogasa of the coefficient of variation', () => {
  near(consistency([80, 80, 80]), 100);
  assert.ok(consistency([40, 120, 80]) < 80);
  near(kogasa(0), 100);
  const cov = Math.sqrt(((40 - 80) ** 2 + 0 + (120 - 80) ** 2) / 3) / 80;
  near(consistency([40, 120, 80]), 100 * (1 - Math.tanh(cov + cov ** 3 / 3 + cov ** 5 / 5)));
  assert.equal(consistency([]), 0);
  assert.equal(consistency([0, 0]), 0);
  assert.equal(wpm(count(['a'], ['a'], 0, false), 0), 0);
});

test('the word list is the English 200; a word never repeats either of the two before it', () => {
  assert.equal(WORD_LIST.length, 200);
  assert.equal(new Set(WORD_LIST).size, 200);
  assert.deepEqual(WORD_LIST.slice(0, 5), ['the', 'be', 'of', 'and', 'a']);
  assert.equal(WORD_LIST.at(-1), 'line');
  const rng = seeded(5);
  for (let k = 0; k < 200; k++) {
    const words = pickWords(rng, ['a', 'b', 'c', 'd']);
    assert.equal(words.length, WORD_COUNT);
    for (let i = 1; i < words.length; i++) {
      assert.notEqual(words[i], words[i - 1]);
      if (i >= 2) assert.notEqual(words[i], words[i - 2]);
    }
  }
});

/** A test on a fake clock: `tick(ms)` moves time on. */
function clocked(targets) {
  let t = 1000;
  const typeTest = new TypeTest({ targets, now: () => t });
  return { typeTest, tick: ms => { t += ms; } };
}
const typeAll = (typeTest, text) => { for (const ch of text) typeTest.addLetter(ch); };

test('a whole test: the last word typed right ends it, no space needed', () => {
  const { typeTest, tick } = clocked(['ab', 'cd']);
  typeTest.addLetter('a');
  tick(1000);
  typeTest.addSample(1);
  typeAll(typeTest, 'b c');
  tick(500);
  typeTest.addLetter('d');
  assert.ok(typeTest.isFinished);
  const r = typeTest.result;
  near(r.seconds, 1.5);
  near(r.wpm, (5 * 60) / 1.5 / 5);
  near(r.acc, 100);
  assert.deepEqual(r.chars, [5, 0, 0, 0]);
  assert.equal(r.samples.length, 2, 'the last half second joins the graph');
  near(r.samples[1].raw, (4 * 60) / 5 / 0.5); // b, space, c, d in the last half second
  assert.equal(typeTest.addLetter('x'), false);
});

test('space at a word start does nothing; a space ending the last word ends the test', () => {
  const { typeTest } = clocked(['ab', 'cd']);
  assert.equal(typeTest.addLetter(' '), false);
  assert.equal(typeTest.isStarted, false);
  typeAll(typeTest, 'ab ');
  assert.equal(typeTest.addLetter(' '), false);
  typeAll(typeTest, 'cx ');
  assert.ok(typeTest.isFinished);
  assert.deepEqual(typeTest.result.chars, [4, 1, 0, 0]);
  assert.equal(typeTest.result.badKeys, 2, 'the wrong letter and the space after a wrong word');
});

test('up to 10 extra letters past a word', () => {
  const { typeTest } = clocked(['ab', 'cd']);
  typeAll(typeTest, 'ab' + 'z'.repeat(15));
  assert.equal(typeTest.typed[0].length, 2 + EXTRA_LIMIT);
});

test('Backspace goes into the previous word only if that word is wrong; Ctrl clears the word', () => {
  const { typeTest } = clocked(['ab', 'cd', 'ef']);
  typeAll(typeTest, 'ab ');
  assert.equal(typeTest.removeLetter(), false, 'a right word stays behind');
  typeAll(typeTest, 'cx ');
  assert.ok(typeTest.isLeftWrong(1));
  assert.ok(typeTest.removeLetter());
  assert.equal(typeTest.current, 1);
  assert.equal(typeTest.typed[1], 'cx');
  typeTest.removeLetter();
  assert.equal(typeTest.typed[1], 'c');
  typeAll(typeTest, 'x ');
  typeTest.removeLetter(true);
  assert.equal(typeTest.current, 1);
  assert.equal(typeTest.typed[1], '');
  typeAll(typeTest, 'cd');
  typeTest.removeLetter(true);
  assert.equal(typeTest.typed[1], '');
});

test('a personal best needs more wpm and some accuracy', () => {
  assert.equal(isBest({ wpm: 50, acc: 90 }, 40), true);
  assert.equal(isBest({ wpm: 40, acc: 90 }, 40), false);
  assert.equal(isBest({ wpm: 50, acc: 0 }, 0), false);
});

test('the graph scale steps up with speed', () => {
  assert.deepEqual(graphScale([]), { top: 20, step: 20 });
  assert.deepEqual(graphScale([{ wpm: 109, raw: 114 }]), { top: 120, step: 20 });
  assert.deepEqual(graphScale([{ wpm: 130, raw: 90 }]), { top: 160, step: 40 });
  assert.deepEqual(graphScale([{ wpm: 250, raw: 90 }]), { top: 320, step: 80 });
});

test('themes: 187 from the file; slambook\'s #AARRGGBB is reordered for CSS', () => {
  const text = readFileSync(new URL('../../widget/TypeThemes.txt', import.meta.url), 'utf8');
  const themes = parseThemes(text);
  assert.equal(themes.length, 187);
  assert.equal(cssColor('#C41C82AD'), '#1C82ADC4');
  assert.equal(cssColor('#323437'), '#323437');
  const slambook = themes.find(t => t.name === 'slambook');
  assert.equal(slambook.colors[3], '#1C82ADC4');
  assert.ok(themes.every(t => t.colors.length === 8 && t.colors.every(c => /^#[0-9A-F]{6}([0-9A-F]{2})?$/i.test(c))));
  assert.deepEqual(filterThemes(themes, 'serika').map(t => t.name).sort(), ['serika', 'serika_dark']);
  assert.ok(filterThemes(themes, 'SERIKA DARK').some(t => t.name === 'serika_dark'));
  assert.equal(filterThemes(themes, '').length, 187);
  assert.deepEqual(parseThemes('').map(t => t.name), ['serika_dark']);
  assert.deepEqual(parseThemes('x|#1|#2|#3|#4|#5|#6|#7|#8').map(t => t.name), ['serika_dark']);
});

test('the save: {pb, theme, themeSet}, each part checked on its own', () => {
  assert.equal(SAVE_THEME_SET, 2);
  assert.deepEqual(saveOf(87.456, 'nord'), { pb: 87.46, theme: 'nord', themeSet: 2 });
  const marked = { pb: 87.46, theme: 'nord', themeSet: 2 };
  assert.deepEqual(readSave(marked, ['nord']), { pb: 87.46, theme: 'nord', marked: true });
  assert.deepEqual(readSave({ ...marked, pb: 'fast' }, ['nord']), { pb: 0, theme: 'nord', marked: true });
  assert.deepEqual(readSave({ ...marked, pb: 50, theme: 'gone' }, ['nord']), { pb: 50, theme: 'auto', marked: true });
  assert.deepEqual(readSave(null), { pb: 0, theme: 'auto', marked: false });
  assert.deepEqual(readSave({ pb: 50, theme: 'auto', themeSet: 2 }, ['auto', 'nord']), { pb: 50, theme: 'auto', marked: true });
  // A save written by the page always reads back as it was written.
  const names = ['auto', 'nord', 'serika_dark'];
  for (const theme of names) assert.equal(readSave(saveOf(80, theme), names).theme, theme);
});

test("a save from before 'auto' follows the colour scheme: its serika_dark was the old default", () => {
  const names = ['auto', 'nord', 'serika_dark'];
  // The old page wrote {pb, theme} with every personal best, the theme 'serika_dark' unless picked.
  assert.deepEqual(readSave({ pb: 82.5, theme: 'serika_dark' }, names), { pb: 82.5, theme: 'auto', marked: false });
  // Any other theme in an old save was picked on purpose: kept, though the save is unmarked.
  assert.deepEqual(readSave({ pb: 82.5, theme: 'nord' }, names), { pb: 82.5, theme: 'nord', marked: false });
  // Once marked (the page saves an unmarked save at once), serika_dark is a choice and stays.
  assert.deepEqual(readSave({ pb: 82.5, theme: 'serika_dark', themeSet: 2 }, names), { pb: 82.5, theme: 'serika_dark', marked: true });
  // Only themeSet 2 marks a save.
  assert.equal(readSave({ pb: 1, theme: 'serika_dark', themeSet: 1 }, names).theme, 'auto');
  assert.equal(readSave({ pb: 1, theme: 'serika_dark', themeSet: '2' }, names).theme, 'auto');
  // The migration, then the save the page writes at once: from then on it reads the same.
  const migrated = readSave({ pb: 82.5, theme: 'serika_dark' }, names);
  assert.deepEqual(readSave(saveOf(migrated.pb, migrated.theme), names), { pb: 82.5, theme: 'auto', marked: true });
});

test('the page marks an unmarked save as soon as it has read it', () => {
  const game = readFileSync(new URL('../public/games/typing/game.js', import.meta.url), 'utf8');
  assert.match(game, /if \(saved && !prefs\.marked\) save\(\);/);
});

test("'auto' follows the colour scheme, and is the theme with none saved", () => {
  assert.equal(AUTO_THEME, 'auto');
  assert.equal(DEFAULT_THEME, AUTO_THEME);
  assert.equal(FALLBACK_THEME, 'serika_dark');
  // The same eight colours widget/TypeTest.ps1's self-test pins for Ember (Get-SchemeAsTheme).
  const ember = Theme.derivePalette(Theme.DEFAULT_COLORS, 0.95);
  assert.deepEqual(schemeAsTheme(ember), ['#1C1D20', '#E08A5F', '#E08A5F', '#90908F', '#2C2D30', '#E8E6E3', '#E0696B', '#884749']);
  // The background is solid whatever the see-through: only its colour comes from cardFill.
  assert.equal(schemeAsTheme(Theme.derivePalette(Theme.DEFAULT_COLORS, 0.4))[0], '#1C1D20');
  // A light scheme takes the light status colours.
  const paper = schemeAsTheme(Theme.derivePalette({ bg: '#F5F2EB', accent: '#C2602F', text: '#1F1E1C' }, 1));
  assert.equal(paper[0], '#F5F2EB');
  assert.equal(paper[1], '#C2602F');
  assert.equal(paper[5], '#1F1E1C');
  assert.equal(paper[6], '#C23B3E');
});

test("'auto' in the picker: its title, its search words, and never a file line", () => {
  assert.equal(themeTitle(AUTO_THEME), 'follow colour scheme');
  assert.equal(themeTitle('serika_dark'), 'serika dark');
  const themes = [{ name: AUTO_THEME, colors: [] }, ...parseThemes('nord|#242933|#88C0D0|#ECEFF4|#929AAA|#2E3440|#D8DEE9|#BF616A|#793E44')];
  for (const query of ['follow', 'colour', 'color', 'auto', 'DEFAULT']) assert.deepEqual(filterThemes(themes, query).map(t => t.name), ['auto'], query);
  assert.deepEqual(filterThemes(themes, 'nord').map(t => t.name), ['nord']);
  // A theme file line named 'auto' can't take the scheme's place.
  assert.deepEqual(parseThemes('auto|#000000|#111111|#222222|#333333|#444444|#555555|#666666|#777777').map(t => t.name), ['serika_dark']);
});

test('withAlpha: a theme colour at the see-through, its own alpha kept', () => {
  assert.equal(withAlpha('#2C2E31', 0.5), 'rgba(44, 46, 49, 0.5)');
  assert.equal(withAlpha('#646669', 80 / 255), 'rgba(100, 102, 105, 0.314)');
  // slambook's sub is #1C82ADC4 in CSS order: its own alpha times the one asked for.
  assert.equal(withAlpha('#1C82ADC4', 1), 'rgba(28, 130, 173, 0.769)');
  assert.equal(withAlpha('#1C82ADC4', 0.5), 'rgba(28, 130, 173, 0.384)');
});

test("schemeName: the preset 'auto' follows, or custom once its colours change", () => {
  const presets = [
    { name: 'ember', label: 'Ember', bg: '#1C1D20', accent: '#E08A5F', text: '#E8E6E3' },
    { name: 'paper', label: 'Paper', bg: '#F5F2EB', accent: '#C2602F', text: '#1F1E1C' },
  ];
  assert.equal(schemeName(Theme.parseAppearance(null), presets), 'ember');
  assert.equal(schemeName({ preset: 'paper', colors: { bg: '#f5f2eb', accent: '#c2602f', text: '#1f1e1c' } }, presets), 'paper');
  assert.equal(schemeName({ preset: 'paper', colors: { bg: '#000000', accent: '#C2602F', text: '#1F1E1C' } }, presets), 'custom');
  assert.equal(schemeName({ preset: 'custom', colors: { bg: '#000000', accent: '#FFD400', text: '#FFFFFF' } }, presets), 'custom');
});

// The schemes the snapshots draw: Ember, Paper and a high-contrast custom one.
const SCHEMES = {
  ember: Theme.DEFAULT_COLORS,
  paper: { bg: '#F5F2EB', accent: '#C2602F', text: '#1F1E1C' },
  hc: { bg: '#000000', accent: '#FFD400', text: '#FFFFFF' },
};
const rgbHex = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

test("'auto': the letters still to type keep the full-opacity dim, so they stay apart from the typed ones", () => {
  for (const [name, colors] of Object.entries(SCHEMES)) {
    const solid = Theme.derivePalette(colors, 1);
    const props = schemeProperties(schemeAsTheme(solid));
    const fullDim = `#${solid.dim.slice(3)}`;
    assert.equal(props['--untyped'], fullDim, `${name}: untyped is the dim at full opacity`);
    assert.equal(props['--text'], `#${solid.ink.slice(3)}`, `${name}: typed is the text`);
    // At 40% the shared dim nears the text; the untyped letters don't follow it.
    const clearDim = `#${Theme.derivePalette(colors, 0.4).dim.slice(3)}`;
    assert.notEqual(clearDim.toUpperCase(), fullDim.toUpperCase(), `${name}: the shared dim moves at 0.4`);
    const apart = Theme.contrast(rgbHex(props['--untyped']), rgbHex(props['--text']));
    assert.ok(apart >= 2.2, `${name}: typed vs untyped ${apart.toFixed(2)}:1`);
    // Hints and labels take the shared dim (legible at any see-through); fills a tint of the text.
    assert.equal(props['--sub'], 'var(--dim)', `${name}: sub is the shared dim`);
    assert.equal(props['--subAlt'], 'var(--surface)', `${name}: subAlt is the shared surface`);
    assert.equal(props['--main'], `#${solid.accent.slice(3)}`, `${name}: main is the accent`);
  }
});

test('the untyped letters are painted with --untyped, which is sub unless game.js says otherwise', () => {
  const page = readFileSync(new URL('../public/games/typing/index.html', import.meta.url), 'utf8');
  assert.match(page, /\.word span \{ color: var\(--untyped\); \}/);
  assert.match(page, /--untyped: var\(--sub\);/);
  const game = readFileSync(new URL('../public/games/typing/game.js', import.meta.url), 'utf8');
  assert.match(game, /root\.setProperty\('--untyped', colors\[3\]\);/, "a Monkeytype theme's untyped letters are its sub");
});

test("'auto' waits for the saved scheme: never a frame of the default (Ember) before it is read", () => {
  const game = readFileSync(new URL('../public/games/typing/game.js', import.meta.url), 'utf8');
  // start() reads the appearance with its other fetches, and takes it unless the watcher was first.
  const start = /async function start\(\) \{[\s\S]*?\n\}/.exec(game)[0];
  assert.match(start, /await Promise\.all\(\[[\s\S]*loadAppearance\(\),[\s\S]*\]\);/);
  assert.match(start, /if \(loaded && !haveScheme\) \{\s*appearance = loaded;\s*haveScheme = true;/);
  assert.ok(start.indexOf('haveScheme = true') < start.indexOf('setTheme(prefs.theme)'), 'the scheme is in before the first setTheme');
  // Until then 'auto' paints nothing of its own: /look.css's first paint stays.
  assert.match(game, /if \(name === AUTO_THEME\) \{\s*if \(!haveScheme\) return clearColors\(\);/);
  assert.match(game, /function schemeChanged\(next\) \{\s*appearance = next;\s*haveScheme = true;/);
});
