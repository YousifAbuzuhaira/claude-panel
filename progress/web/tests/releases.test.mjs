// The Releases tab's data: progress/releases.json, checked as tools/check-releases.mjs checks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkReleases, compareVersions } from '../../tools/check-releases.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const entry = (version, extra = {}) => ({ version, date: '2026-10-30', by: 'Yousif', notes: ['A note'], ...extra });

test('the shipped releases match plugin.json and pass every rule', () => {
  const { version } = read('../../.claude-plugin/plugin.json');
  assert.deepEqual(checkReleases(read('../../releases.json'), version), []);
});

test('a version bump without its entry is caught', () => {
  const problems = checkReleases({ releases: [entry('0.2.0')] }, '0.3.0');
  assert.match(problems[0], /add its entry/);
});

test('entries go newest first', () => {
  assert.equal(checkReleases({ releases: [entry('0.2.0'), entry('0.3.0')] }, '0.2.0').length, 1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
});

test('each entry says when, who and what, briefly', () => {
  const bad = entry('1.0.0', { date: 'today', by: ' ', notes: ['x'.repeat(71), 'b', 'c', 'd'] });
  const problems = checkReleases({ releases: [bad] }, '1.0.0');
  assert.ok(problems.some(p => p.includes('date')));
  assert.ok(problems.some(p => p.includes('who made it')));
  assert.ok(problems.some(p => p.includes('1 to 3 notes')));
  assert.ok(problems.some(p => p.includes('over 70')));
});
