// The colour scheme: theme.js gives the palettes pinned in tests/theme-vectors.json, which
// widget/Theme.ps1 must give too (tests/ThemeVectors.ps1 checks that side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import('../public/shared/theme.js');
const T = globalThis.ClaudeTheme;
const vectors = JSON.parse(readFileSync(new URL('../../tests/theme-vectors.json', import.meta.url), 'utf8'));

test('every pinned scheme derives exactly its expected roles', () => {
  for (const c of vectors.cases) {
    const palette = T.derivePalette(c.colors, c.opacity);
    for (const role of T.ROLES) assert.equal(palette[role], c.expected[role], `${c.name}.${role}`);
  }
});

test('the vectors cover every role', () => {
  for (const c of vectors.cases) assert.deepEqual(Object.keys(c.expected).sort(), [...T.ROLES].sort());
});

test("Ember, today's look, keeps today's panel and Learn colours", () => {
  const p = T.derivePalette(T.DEFAULT_COLORS, T.DEFAULT_OPACITY.panel);
  assert.equal(p.ink, '#FFE8E6E3');
  assert.equal(p.accent, '#FFE08A5F');
  assert.equal(p.cardFill, '#EB1C1D20');
  assert.equal(p.onAccent, '#FF1C1D20');
  assert.equal(T.derivePalette(T.DEFAULT_COLORS, T.DEFAULT_OPACITY.learn).cardFill, '#F51C1D20');
  assert.equal(T.derivePalette(T.DEFAULT_COLORS, T.DEFAULT_OPACITY.games).cardFill, '#F21C1D20');
});

test('a light background takes the light status colours', () => {
  const p = T.derivePalette({ bg: '#F5F2EB', accent: '#C2602F', text: '#1F1E1C' }, 1);
  assert.equal(p.isDark, false);
  assert.equal(p.green, '#FF2F8A5B');
  assert.equal(p.red, '#FFC23B3E');
});

test('opacity is the background only, and never below the floor', () => {
  const p = T.derivePalette(T.DEFAULT_COLORS, 0.01);
  assert.equal(p.cardFill.slice(0, 3), '#26');
  assert.equal(p.ink.slice(0, 3), '#FF');
  assert.equal(p.accent.slice(0, 3), '#FF');
});

test('a broken appearance falls back field by field', () => {
  const a = T.parseAppearance('{"colors":{"bg":"#123456","accent":"red"},"opacity":{"panel":7,"games":"x"}}');
  assert.equal(a.preset, 'ember');
  assert.equal(a.colors.bg, '#123456');
  assert.equal(a.colors.accent, T.DEFAULT_COLORS.accent);
  assert.equal(a.opacity.panel, 1);
  assert.equal(a.opacity.games, T.DEFAULT_OPACITY.games);
  assert.deepEqual(T.parseAppearance('not json').colors, T.DEFAULT_COLORS);
});

test('presets keep only well-formed entries, and Ember when none are', () => {
  assert.equal(T.parsePresets('{"presets":[{"name":"x","bg":"#000000","accent":"#FFFFFF","text":"#FFFFFF"},{"name":"bad"}]}').length, 1);
  assert.equal(T.parsePresets('{}')[0].name, 'ember');
  const shipped = T.parsePresets(readFileSync(new URL('../../widget/Presets.json', import.meta.url), 'utf8'));
  assert.equal(shipped[0].name, 'ember');
  assert.deepEqual({ bg: shipped[0].bg, accent: shipped[0].accent, text: shipped[0].text }, T.DEFAULT_COLORS);
});

test('roles become CSS variables and colours', () => {
  assert.equal(T.cssName('accentSoft'), '--accent-soft');
  assert.equal(T.cssName('surface2'), '--surface2');
  assert.equal(T.cssColor('#FFE08A5F'), '#e08a5f');
  assert.equal(T.cssColor('#80000000'), 'rgba(0, 0, 0, 0.502)');
});
