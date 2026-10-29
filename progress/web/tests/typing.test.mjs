// The typing test: Monkeytype's scoring (the WPF self-test's cases), input rules,
// words, themes and the save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EXTRA_LIMIT, TypeTest, WORD_COUNT, WORD_LIST, consistency, count, cssColor, filterThemes, graphScale,
  isBest, kogasa, parseThemes, pickWords, raw, readSave, saveOf, wpm,
} from '../public/games/typing/logic.js';
import { seeded } from '../public/games/rng.js';

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

test('the save: {pb, theme}, each part checked on its own', () => {
  assert.deepEqual(saveOf(87.456, 'nord'), { pb: 87.46, theme: 'nord' });
  assert.deepEqual(readSave({ pb: 87.46, theme: 'nord' }, ['nord']), { pb: 87.46, theme: 'nord' });
  assert.deepEqual(readSave({ pb: 'fast', theme: 'nord' }, ['nord']), { pb: 0, theme: 'nord' });
  assert.deepEqual(readSave({ pb: 50, theme: 'gone' }, ['nord']), { pb: 50, theme: 'serika_dark' });
  assert.deepEqual(readSave(null), { pb: 0, theme: 'serika_dark' });
});
