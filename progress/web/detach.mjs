// Starts a program on its own and returns at once: Windows' twin of `nohup "$@" &`, for the
// windows a chat opens there (Learn's launcher, the games). Hidden, so no console flashes up,
// and detached, so the window stays when the chat ends.
//   node detach.mjs <program> [args...]
import { spawn } from 'node:child_process';

const [program, ...args] = process.argv.slice(2);
if (!program) {
  process.stderr.write('usage: node detach.mjs <program> [args...]\n');
  process.exit(2);
}
const child = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: true });
child.on('error', error => {
  process.stderr.write(`could not start ${program}: ${error.message}\n`);
  process.exit(1);
});
child.on('spawn', () => {
  child.unref();
  process.exit(0);
});
