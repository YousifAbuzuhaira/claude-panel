// A library's jobs: each a JSON file under jobs/ and a process of its own that outlives whoever
// started it. Shared by course builds (build.mjs) and explainers (explain-job.mjs), so it needs
// nothing of courses. Every save also writes the panel's build line (status.json).
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readdirSync } from 'node:fs';
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
