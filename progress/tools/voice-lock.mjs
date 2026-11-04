// Writes learn/voice/requirements.lock from requirements.in: each pinned package with the sha256
// of every wheel Python 3.12 can use on Linux or Apple Silicon, as PyPI lists them. Run it by
// hand after changing a pin. Reads PyPI only; it installs and runs nothing.
//   node progress/tools/voice-lock.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const IN = fileURLToPath(new URL('../learn/voice/requirements.in', import.meta.url));
const OUT = fileURLToPath(new URL('../learn/voice/requirements.lock', import.meta.url));

/** Can Python 3.12 on Linux (x86-64, Arm) or Apple Silicon install this wheel? */
export function wheelFits(filename) {
  const match = /-([^-]+)-([^-]+)-([^-]+)\.whl$/.exec(filename);
  if (!match) return false;
  const [, python, abi, platform] = match;
  const fitsPython = python.split('.').some(tag => tag === 'cp312' || tag === 'py3' || tag === 'py2' || (abi === 'abi3' && /^cp3\d+$/.test(tag) && Number(tag.slice(3)) <= 12));
  const fitsPlatform = platform === 'any' || platform.split('.').some(tag => /^manylinux.*_(x86_64|aarch64)$/.test(tag) || /^macosx_.*_arm64$/.test(tag));
  return fitsPython && fitsPlatform;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pins = readFileSync(IN, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const out = ['# Written by tools/voice-lock.mjs from requirements.in. Do not edit by hand.'];
  for (const pin of pins) {
    const [name, version] = pin.split('==');
    const response = await fetch(`https://pypi.org/pypi/${name}/${version}/json`, { headers: { 'User-Agent': 'claude-learn' } });
    if (!response.ok) throw new Error(`${pin}: PyPI said ${response.status}`);
    const wheels = (await response.json()).urls.filter(item => item.packagetype === 'bdist_wheel' && wheelFits(item.filename));
    if (!wheels.length) throw new Error(`${pin}: no wheel fits`);
    out.push(`${pin} \\`, ...wheels.map((item, index) => `    --hash=sha256:${item.digests.sha256}${index < wheels.length - 1 ? ' \\' : ''}`));
  }
  writeFileSync(OUT, `${out.join('\n')}\n`);
  console.log(`${pins.length} packages written to ${OUT}`);
}
