#!/usr/bin/env node
// Checks progress/releases.json, the data behind every panel's Releases tab:
// the newest entry is the version in plugin.json, versions go down, and every entry
// says when, who and what, in a few short lines.
//   node progress/tools/check-releases.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_NOTES = 3;
export const MAX_NOTE_CHARS = 70;

const parts = version => String(version).split('.').map(Number);
const isVersion = version => /^\d+\.\d+\.\d+$/.test(String(version));

/** -1, 0 or 1, comparing two x.y.z versions. */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Every problem with the releases data, as sentences; none means it is fine. */
export function checkReleases(data, pluginVersion) {
  const problems = [];
  const releases = data && Array.isArray(data.releases) ? data.releases : null;
  if (!releases || releases.length === 0) return ['releases.json has no releases'];
  if (releases[0].version !== pluginVersion) {
    problems.push(`the newest release is ${releases[0].version}, but plugin.json says ${pluginVersion}: add its entry`);
  }
  releases.forEach((release, i) => {
    const name = release && release.version ? release.version : `entry ${i + 1}`;
    if (!release || !isVersion(release.version)) problems.push(`${name}: version must look like 1.2.3`);
    if (!release || !/^\d{4}-\d{2}-\d{2}$/.test(String(release.date))) problems.push(`${name}: date must look like 2026-10-30`);
    if (!release || typeof release.by !== 'string' || !release.by.trim()) problems.push(`${name}: "by" must say who made it`);
    const notes = release && Array.isArray(release.notes) ? release.notes : [];
    if (notes.length < 1 || notes.length > MAX_NOTES) problems.push(`${name}: 1 to ${MAX_NOTES} notes`);
    for (const note of notes) {
      if (typeof note !== 'string' || !note.trim()) problems.push(`${name}: an empty note`);
      else if (note.length > MAX_NOTE_CHARS) problems.push(`${name}: "${note.slice(0, 30)}…" is over ${MAX_NOTE_CHARS} characters`);
    }
    const next = releases[i + 1];
    if (next && isVersion(release.version) && isVersion(next.version) && compareVersions(release.version, next.version) <= 0) {
      problems.push(`${name} must be newer than ${next.version}, the entry after it (newest first)`);
    }
  });
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('..', import.meta.url);
  const data = JSON.parse(readFileSync(new URL('releases.json', root), 'utf8'));
  const { version } = JSON.parse(readFileSync(new URL('.claude-plugin/plugin.json', root), 'utf8'));
  const problems = checkReleases(data, version);
  for (const problem of problems) console.error(`releases: ${problem}`);
  if (problems.length) process.exit(1);
  console.log(`releases: ok (${data.releases.length}, newest ${data.releases[0].version})`);
}
