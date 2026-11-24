// A library's jobs: each a JSON file under jobs/ and a process of its own that outlives whoever
// started it. Shared by course builds (build.mjs) and explainers (explain-job.mjs), so it needs
// nothing of courses. Every save also writes the panel's build line (status.json).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { buildStatus, writeStatus } from './status.mjs';
import { readJson, withLock, writeJson } from './store.mjs';

export const now = () => new Date().toISOString();

export const readJob = (lib, id) => readJson(lib.paths.job(id));

export function saveJob(lib, job) {
  const next = { ...job, updatedAt: now() };
  withLock(lib.root, () => writeJson(lib.paths.job(job.id), next));
  writeStatus({ build: buildStatus(next) });
  return next;
}

export function listJobs(lib) {
  let names = [];
  try {
    names = readdirSync(lib.paths.jobs).filter(name => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map(name => readJson(`${lib.paths.jobs}/${name}`)).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const START_GRACE_MS = 60_000; // a job just started, before its process writes its pid

/**
 * A running job that really is: its process lives, or it was just started and hasn't written its
 * pid yet. Whoever (re)starts a job saves `pid: null` first, so asked for again in that moment it
 * isn't started twice (two processes would record the same clip).
 */
export const isJobLive = job => job.state === 'running' && (job.pid ? isAlive(job.pid) : Date.now() - Date.parse(job.updatedAt || job.startedAt) < START_GRACE_MS);

/** Starts `node <argv>` for job `id` on its own, outliving whoever started it; its output goes to the job's log. */
export function spawnJob(lib, id, argv) {
  mkdirSync(lib.paths.jobs, { recursive: true });
  const log = openSync(lib.paths.jobLog(id), 'a');
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: ['ignore', log, log],
    cwd: lib.root,
    env: { ...process.env, CLAUDE_PROGRESS_OFF: '1' },
    // Hidden on Windows: else the build, and every claude it starts, opens a console window.
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

/** A process's command line: from /proc, PowerShell on Windows, else ps. */
function commandOf(pid) {
  if (process.platform === 'win32') {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).stdout || '';
  }
  if (existsSync('/proc/self/cmdline')) return readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8');
  return spawnSync('ps', ['-ww', '-p', String(Number(pid)), '-o', 'command='], { encoding: 'utf8' }).stdout || '';
}

/**
 * Whether process `pid` is the one running job `id` (its command names it). Pids are used again, so
 * one saved before a restart can be anything by now, and stopping a job must never end something else.
 */
export function runsJob(pid, id) {
  if (!pid || !isAlive(pid)) return false;
  try {
    return commandOf(pid).includes(id);
  } catch {
    return false;
  }
}

/**
 * Stops a job's process. Elsewhere SIGTERM lets it stop its own claude runs; Windows has no signals
 * (kill ends the process at once and its children run on), so taskkill ends the whole tree.
 */
function stopProcess(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

/** Pauses a job: its process told to stop, what it made kept. */
export function cancelJob(lib, id) {
  const job = readJob(lib, id);
  if (!job) throw new Error('no such build');
  if (job.state === 'done' || job.state === 'failed') return;
  if (runsJob(job.pid, id)) stopProcess(job.pid);
  saveJob(lib, { ...readJob(lib, id), state: 'paused', message: 'Paused' });
}

/** cancelJob, then a wait for its process to end: false when it's still finishing something. */
export async function stopJob(lib, id, waitMs = 5000) {
  const pid = readJob(lib, id)?.pid;
  cancelJob(lib, id);
  const until = Date.now() + waitMs;
  while (runsJob(pid, id)) {
    if (Date.now() > until) return false;
    await new Promise(done => setTimeout(done, 200));
  }
  return true;
}
