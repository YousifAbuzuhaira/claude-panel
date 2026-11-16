// Starts a program on its own and returns: Windows' twin of `nohup "$@" &`, for the windows a
// chat opens there (Learn's launcher, the games), which stay when the chat ends.
//
// Two hops, because each obvious one fails on Windows:
// - `detached` starts the child with no console at all, and Windows PowerShell won't start then;
// - without it, Node keeps the child in a job that ends it when Node exits.
// So a hidden cmd.exe (windowsHide: a console of its own with no window) runs `start /b`, which
// starts the program on that console, outside Node's job (its children may leave it), and returns.
// The program keeps the windowless console after cmd and this process are gone.
//   node detach.mjs <program> [args...]
import { spawn } from 'node:child_process';

/** One argument as cmd.exe passes it on: quoted when it has a space; refused when cmd would read it. */
export function cmdArg(text) {
  const value = String(text);
  if (/["%^&|<>\r\n]/.test(value)) throw new Error(`can't pass ${JSON.stringify(value)} through cmd.exe`);
  return value === '' || /\s/.test(value) ? `"${value}"` : value;
}

/** cmd.exe's arguments (verbatim) for starting `program args` on its console and returning. */
export const startLine = (program, args) => ['/d', '/s', '/c', `"start "" /b ${[program, ...args].map(cmdArg).join(' ')}"`];

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  const [program, ...args] = process.argv.slice(2);
  if (!program) {
    process.stderr.write('usage: node detach.mjs <program> [args...]\n');
    process.exit(2);
  }
  let line;
  try {
    line = startLine(program, args);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  const hop = spawn(process.env.ComSpec || 'cmd.exe', line, { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  hop.on('error', error => {
    process.stderr.write(`could not start ${program}: ${error.message}\n`);
    process.exit(1);
  });
  // cmd returns once `start` has started the program; leaving earlier would end cmd first.
  hop.on('exit', code => process.exit(code ?? 1));
}
