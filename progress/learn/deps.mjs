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

/** The small zipapp needs Python 3.9+; the standalone build needs nothing. */
function hasPython() {
  try {
    execFileSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function installedYtDlp() {
  const info = readJson(INSTALLED);
  return info && existsSync(info.path) ? info : null;
}

async function download(url) {
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
  // The standalone builds are per platform: Linux (and WSL) or macOS.
  const name = hasPython() ? 'yt-dlp' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
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
  const path = join(folder, 'yt-dlp');
  writeFileSync(path, bytes);
  chmodSync(path, 0o755);
  writeJson(INSTALLED, { version, path, asset: name, sha256: actual, checkedAt: new Date().toISOString() });
  return path;
}
