// yt-dlp, fetched by us rather than taken from the system: YouTube changes often enough
// that a packaged copy stops reading captions (Ubuntu's 2024 one already has). The
// release's own SHA2-256SUMS checks the download; it's refreshed after 14 days, or
// sooner when a caption fetch fails.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR } from './settings.mjs';
import { readJson, writeJson } from './store.mjs';

const RELEASES = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const DIR = join(CACHE_DIR, 'yt-dlp');
const INSTALLED = join(DIR, 'installed.json');
const MAX_AGE_DAYS = 14;

const runs = (argv, check = 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)') => {
  try {
    execFileSync(argv[0], [...argv.slice(1), '-c', check], { stdio: 'ignore', timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

/**
 * The first python3 on PATH. On a Mac /usr/bin/python3 is a stub until Apple's developer tools
 * are installed, and running it opens their "install" dialog, so it counts only once
 * `xcode-select -p` (which never asks) says the tools are there.
 */
function macPython() {
  const first = (process.env.PATH || '').split(':').filter(Boolean).map(dir => join(dir, 'python3')).find(path => existsSync(path));
  if (!first) return null;
  if (first === '/usr/bin/python3') {
    try {
      execFileSync('xcode-select', ['-p'], { stdio: 'ignore', timeout: 5_000 });
    } catch {
      return null;
    }
  }
  return [first];
}

let python;

/**
 * How to start Python 3.9+ that really runs (not a stub that offers to install it), for pypdf
 * and the yt-dlp zipapp: `python3`; on Windows the py launcher first (python.org's installer
 * puts no python3 on PATH, and its python.exe may be the Store's stub); null without one.
 */
export function pythonArgv() {
  if (python !== undefined) return python;
  const candidates = process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : process.platform === 'darwin' ? [macPython()].filter(Boolean) : [['python3']];
  python = candidates.find(argv => runs(argv)) ?? null;
  return python;
}

export const hasPython = () => pythonArgv() !== null;

export function installedYtDlp() {
  const info = readJson(INSTALLED);
  return info && existsSync(info.path) ? info : null;
}

export async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'claude-learn' } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Installs the latest release when missing, old, or `force`d; returns its path. */
export async function ensureYtDlp({ force = false, onProgress = () => {} } = {}) {
  const current = installedYtDlp();
  const ageDays = current ? (Date.now() - Date.parse(current.checkedAt)) / 86_400_000 : Infinity;
  if (current && !force && ageDays < MAX_AGE_DAYS) return current.path;
  let release;
  try {
    const response = await fetch(RELEASES, { headers: { 'User-Agent': 'claude-learn', Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`GitHub said ${response.status}`);
    release = await response.json();
  } catch (error) {
    if (current) return current.path; // offline: keep what works
    throw new Error(`can't reach GitHub to get yt-dlp: ${error.message}`);
  }
  const version = release.tag_name;
  if (current && current.version === version) {
    writeJson(INSTALLED, { ...current, checkedAt: new Date().toISOString() });
    return current.path;
  }
  // The standalone builds are per platform. A Mac always takes its own: its stock Python is older
  // than yt-dlp wants. Linux (and WSL) takes the small zipapp when Python runs.
  const name = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : hasPython() ? 'yt-dlp' : 'yt-dlp_linux';
  const asset = release.assets.find(item => item.name === name);
  const sums = release.assets.find(item => item.name === 'SHA2-256SUMS');
  if (!asset || !sums) throw new Error(`yt-dlp ${version} has no ${name} download`);
  onProgress(`Downloading yt-dlp ${version}`);
  const [bytes, sumsText] = await Promise.all([download(asset.browser_download_url), download(sums.browser_download_url).then(String)]);
  const expected = sumsText.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === name)?.[0];
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!expected || expected !== actual) throw new Error(`yt-dlp ${version} failed its checksum`);
  const folder = join(DIR, version);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  writeFileSync(path, bytes);
  chmodSync(path, 0o755);
  writeJson(INSTALLED, { version, path, asset: name, sha256: actual, checkedAt: new Date().toISOString() });
  return path;
}

// --- pypdf ---------------------------------------------------------------------------------
// A PDF's text and bookmarks come from pypdf (pure Python, run with the system's python3),
// fetched from PyPI the first time a PDF is read and checked against PyPI's own sha256. Python
// imports it straight from the wheel. Refreshed after 30 days; offline, the copy we have is kept.

const PYPDF = 'https://pypi.org/pypi/pypdf/json';
const PYPDF_DIR = join(CACHE_DIR, 'pypdf');
const PYPDF_INSTALLED = join(PYPDF_DIR, 'installed.json');
const PYPDF_MAX_AGE_DAYS = 30;

export function installedPypdf() {
  const info = readJson(PYPDF_INSTALLED);
  return info && existsSync(info.path) ? info : null;
}

/** The pypdf wheel's path, fetched when missing or old; throws when python3 can't run it. */
export async function ensurePypdf({ onProgress = () => {} } = {}) {
  if (!hasPython()) throw new Error(`reading a PDF needs Python 3.9 or newer (${process.platform === 'win32' ? 'from python.org' : 'python3'})`);
  const current = installedPypdf();
  const ageDays = current ? (Date.now() - Date.parse(current.checkedAt)) / 86_400_000 : Infinity;
  if (current && ageDays < PYPDF_MAX_AGE_DAYS) return current.path;
  let meta;
  try {
    const response = await fetch(PYPDF, { headers: { 'User-Agent': 'claude-learn', Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`PyPI said ${response.status}`);
    meta = await response.json();
  } catch (error) {
    if (current) return current.path;
    throw new Error(`can't reach PyPI to get pypdf: ${error.message}`);
  }
  const version = meta.info?.version;
  const wheel = (meta.urls || []).find(item => item.packagetype === 'bdist_wheel' && /py3-none-any\.whl$/.test(item.filename));
  if (!version || !wheel) throw new Error('PyPI has no pypdf wheel');
  if (current && current.version === version) {
    writeJson(PYPDF_INSTALLED, { ...current, checkedAt: new Date().toISOString() });
    return current.path;
  }
  onProgress(`Downloading pypdf ${version}`);
  const bytes = await download(wheel.url);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== wheel.digests?.sha256) throw new Error(`pypdf ${version} failed its checksum`);
  const folder = join(PYPDF_DIR, version);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, wheel.filename);
  writeFileSync(path, bytes);
  writeJson(PYPDF_INSTALLED, { version, path, sha256: actual, checkedAt: new Date().toISOString() });
  return path;
}
