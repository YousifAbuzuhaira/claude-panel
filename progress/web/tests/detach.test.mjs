// detach.mjs: the line cmd.exe gets to start a window on its own (Windows itself, no WSL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmdArg, startLine } from '../detach.mjs';

test('arguments with spaces are quoted; plain ones pass as they are', () => {
  assert.equal(cmdArg('-NoProfile'), '-NoProfile');
  assert.equal(cmdArg('C:\\Program Files\\x\\Learn.ps1'), '"C:\\Program Files\\x\\Learn.ps1"');
  assert.equal(cmdArg(''), '""');
});

test('anything cmd.exe would read itself is refused, never passed', () => {
  for (const bad of ['a"b', '%PATH%', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a\nb']) assert.throws(() => cmdArg(bad), /cmd\.exe/, bad);
});

test('start /b starts the program on cmd\'s own windowless console, and cmd returns', () => {
  assert.deepEqual(startLine('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-File', 'C:\\Users\\me\\progress\\widget\\Sudoku.ps1', '-SessionId', 's1']), [
    '/d', '/s', '/c', '"start "" /b C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -File C:\\Users\\me\\progress\\widget\\Sudoku.ps1 -SessionId s1"',
  ]);
});
