// The narrator: Kokoro, a voice model run locally from Python. Nothing here ships with the mod:
// on first use it's fetched into the cache, each piece pinned and checked. uv brings its own
// Python 3.12, because the voice's engine needs 3.11 or newer, macOS ships 3.9, and some Linux
// Pythons can't make a venv with pip. The voice's packages come from requirements.lock, by hash.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, constants, platform, release, setPriority } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { running } from './claude.mjs';
import { download } from './deps.mjs';
import { CACHE_DIR } from './settings.mjs';
import { readJson, renameRetry, writeJson } from './store.mjs';

export const VOICE = 'af_heart';
export const SETUP_MB = 350;
const PYTHON = '3.12';
const UV_VERSION = '0.13.7';
const UV_TARGETS = {
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', sha256: 'c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', sha256: '71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc' },
  'darwin-arm64': { target: 'aarch64-apple-darwin', sha256: '81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731' },
  // Windows itself: a zip, not a tarball, holding uv.exe.
  'win32-x64': { target: 'x86_64-pc-windows-msvc', sha256: '0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021', zip: true },
};
const IS_WINDOWS = platform() === 'win32';
// The timed export, which reports how long each sound lasts: that's where word times come from.
const MODELS = [
  { name: 'timed.onnx', sha256: 'c0c02b3299fd97c34ea92a98e6d41eaa1a739c8f77bf685aac34bd7b34c1132c', url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/dd4401a9add81ac692d20e240d22ec9dda82cc29/onnx/model_quantized.onnx' },
  { name: 'voices-v1.0.bin', sha256: 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d', url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin' },
];
const DIR = process.env.LEARN_VOICE_DIR || join(CACHE_DIR, 'voice');
const INSTALLED = join(DIR, 'installed.json');
const MODEL_DIR = join(DIR, 'model');
// A Windows venv keeps Python in Scripts, as python.exe.
const PYTHON_BIN = IS_WINDOWS ? join(DIR, 'env', 'Scripts', 'python.exe') : join(DIR, 'env', 'bin', 'python');
// Windows has its own lock (win_amd64 wheels), so Linux and Mac installs never see a change.
const LOCK = fileURLToPath(new URL(IS_WINDOWS ? './voice/requirements.win.lock' : './voice/requirements.lock', import.meta.url));
const NARRATE = fileURLToPath(new URL('./voice/narrate.py', import.meta.url));

/** The uv build for this machine, or why videos can't run here. macOS 14 is Darwin 23. */
export function voicePlatform(system = platform(), cpu = arch(), kernel = release()) {
  if (system === 'darwin' && cpu !== 'arm64') return { reason: 'The video voice needs an Apple Silicon Mac: its engine has no Intel build.' };
  if (system === 'darwin' && Number.parseInt(kernel, 10) < 23) return { reason: 'The video voice needs macOS 14 or newer.' };
  const uv = UV_TARGETS[`${system}-${cpu}`];
  return uv || { reason: `The video voice has no build for ${system} on ${cpu}.` };
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const lockHash = () => sha256(readFileSync(LOCK));

/** `ready`, or why not: `needsSetup` means pressing the button will fix it; `reason` that it can't. */
export function voiceStatus() {
  const { reason } = voicePlatform();
  if (reason) return { ready: false, needsSetup: false, reason };
  const info = readJson(INSTALLED);
  const ready = Boolean(info && info.lock === lockHash() && existsSync(PYTHON_BIN) && MODELS.every(model => existsSync(join(MODEL_DIR, model.name))));
  return { ready, needsSetup: !ready, setupMb: SETUP_MB };
}

function runUv(uv, args, env) {
  const result = spawnSync(uv, args, { env: { ...process.env, ...env, VIRTUAL_ENV: '' }, encoding: 'utf8', timeout: 20 * 60_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`voice setup failed: ${String(result.stderr || result.error?.message || 'uv stopped').trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
}

async function fetchUv() {
  const uv = voicePlatform();
  if (uv.reason) throw new Error(uv.reason);
  const folder = join(DIR, 'uv', UV_VERSION);
  const path = join(folder, uv.zip ? 'uv.exe' : 'uv');
  if (existsSync(path)) return path;
  const bytes = await download(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv.target}.${uv.zip ? 'zip' : 'tar.gz'}`);
  if (sha256(bytes) !== uv.sha256) throw new Error(`uv ${UV_VERSION} failed its checksum`);
  mkdirSync(folder, { recursive: true });
  if (uv.zip) {
    // Windows' own tar (bsdtar) reads zips; Git's GNU tar, if it came first on PATH, doesn't.
    const archive = join(folder, 'uv.zip');
    writeFileSync(archive, bytes);
    const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const unpacked = spawnSync(tar, ['-xf', archive, '-C', folder], { windowsHide: true });
    rmSync(archive, { force: true });
    // uv.exe sits at the top of the zip.
    if (unpacked.status !== 0 || !existsSync(path)) throw new Error('could not unpack uv');
    return path;
  }
  const unpacked = spawnSync('tar', ['-xzf', '-', '-C', folder, '--strip-components=1'], { input: bytes });
  if (unpacked.status !== 0) throw new Error('could not unpack uv');
  return path;
}

async function fetchModel(model) {
  const path = join(MODEL_DIR, model.name);
  if (existsSync(path) && sha256(readFileSync(path)) === model.sha256) return;
  const bytes = await download(model.url);
  if (sha256(bytes) !== model.sha256) throw new Error(`${model.name} failed its checksum`);
  mkdirSync(MODEL_DIR, { recursive: true });
  writeFileSync(`${path}.tmp`, bytes);
  renameRetry(`${path}.tmp`, path);
}

/** Installs what's missing. Safe to run again after a stop: each piece is checked first. */
export async function ensureVoice({ onProgress = () => {} } = {}) {
  if (voiceStatus().ready) return;
  mkdirSync(DIR, { recursive: true });
  onProgress('Getting the installer');
  const uv = await fetchUv();
  const env = { UV_PYTHON_INSTALL_DIR: join(DIR, 'python'), UV_CACHE_DIR: join(DIR, 'download-cache'), UV_NO_CONFIG: '1', UV_PYTHON_PREFERENCE: 'only-managed' };
  onProgress(`Getting Python ${PYTHON}`);
  runUv(uv, ['venv', join(DIR, 'env'), '--clear', '--no-project', '--python', PYTHON], env);
  onProgress('Getting the voice\'s packages');
  runUv(uv, ['pip', 'install', '--python', PYTHON_BIN, '--require-hashes', '--only-binary', ':all:', '-r', LOCK], env);
  for (const model of MODELS) {
    onProgress(`Getting the voice model: ${model.name}`);
    await fetchModel(model);
  }
  rmSync(join(DIR, 'download-cache'), { recursive: true, force: true });
  writeJson(INSTALLED, { lock: lockHash(), uv: UV_VERSION, python: PYTHON, at: new Date().toISOString() });
}

/**
 * Records a script. Resolves when `<out>.json` and `<out>.mp3` exist. `onProgress(said, of)` runs
 * as sentences are done. A job's stop kills it through `running`, like a Claude run. `kbps` is the
 * MP3's constant bitrate (narrate.py's LEVELS); left out, 64.
 */
export function record({ scriptFile, out, kbps = null, onProgress = () => {} }) {
  const child = spawn(PYTHON_BIN, ['-I', NARRATE, MODEL_DIR, scriptFile, out, VOICE, ...(kbps ? [String(kbps)] : [])], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  // Windows has no nice (narrate.py lowers itself elsewhere): Node sets its priority class instead.
  if (IS_WINDOWS && child.pid) {
    try { setPriority(child.pid, constants.priority.PRIORITY_LOW); } catch {}
  }
  let stopped = false;
  const run = { stop() { stopped = true; child.kill('SIGTERM'); } };
  running.add(run);
  const done = new Promise((resolve, reject) => {
    let stderr = '';
    let pending = '';
    let total = 0;
    let last = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      const lines = (pending + text).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value.sentences) total = value.sentences;
          if (value.said) onProgress(value.said, total);
          if (value.done) last = value;
        } catch {}
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { stderr = (stderr + text).slice(-2000); });
    child.on('error', error => reject(new Error(`can't start the voice: ${error.message}`)));
    child.on('close', code => {
      if (stopped) reject(Object.assign(new Error('stopped'), { stopped: true }));
      else if (code === 0 && last) resolve(last);
      else reject(new Error(`the voice stopped: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300) || `exit ${code}`}`));
    });
  });
  return done.finally(() => running.delete(run));
}
