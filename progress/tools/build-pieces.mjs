// Builds widget/ChessPieces.txt: Lichess's default "cburnett" chess pieces
// (Colin M.L. Burnett, GPLv2+) turned into WPF path layers.
//
//   node tools/build-pieces.mjs --out widget/ChessPieces.txt [--src <dir with the 12 svgs>]
//
// Without --src the SVGs are read from lichess-org/lila on GitHub. Every path is
// rewritten to absolute M L C Q A Z commands, which WPF's path markup reads
// without the shorthand quirks of minified SVG ("1.5.5", "a2 2 0 11-4 0").
// Anything the converter doesn't know stops the build rather than drawing wrong.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, word, i, all) => {
    if (word.startsWith('--')) pairs.push([word.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
if (!args.out) {
  console.error('usage: node tools/build-pieces.mjs --out <txt> [--src <dir>]');
  process.exit(2);
}
const PIECES = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
const SOURCE = 'https://raw.githubusercontent.com/lichess-org/lila/master/public/piece/cburnett';
const INHERITED = ['fill', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];
const IGNORED = new Set(['xmlns', 'width', 'height', 'viewBox', 'style', 'd', 'cx', 'cy', 'r']);
const DEFAULTS = { fill: '#000', 'fill-rule': 'nonzero', stroke: 'none', 'stroke-width': '1', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter' };

function fail(message) {
  console.error(`build-pieces: ${message}`);
  process.exit(1);
}

function readAttributes(tag, piece) {
  const found = {};
  for (const [, name, value] of tag.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) {
    if (!INHERITED.includes(name) && !IGNORED.has(name)) fail(`${piece}: attribute ${name} is not handled`);
    found[name] = value;
  }
  if (found.style && !/^color-scheme:[a-z ]+$/.test(found.style)) fail(`${piece}: style "${found.style}" is not handled`);
  return found;
}

function toArgb(colour, piece) {
  if (colour === 'none') return 'none';
  let hex = colour.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) fail(`${piece}: colour ${colour} is not handled`);
  return `#FF${hex.toUpperCase()}`;
}

const formatNumber = value => {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

// Reads an SVG path's "d" into absolute commands.
function normalisePath(d, piece) {
  let at = 0;
  const skip = () => { while (at < d.length && /[\s,]/.test(d[at])) at++; };
  const readNumber = () => {
    skip();
    const match = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(d.slice(at));
    if (!match) fail(`${piece}: expected a number at "${d.slice(at, at + 12)}"`);
    at += match[0].length;
    return Number(match[0]);
  };
  const readFlag = () => {
    skip();
    const flag = d[at];
    if (flag !== '0' && flag !== '1') fail(`${piece}: expected an arc flag at "${d.slice(at, at + 12)}"`);
    at++;
    return Number(flag);
  };
  const hasNumber = () => { skip(); return at < d.length && /[-+.\d]/.test(d[at]); };

  const out = [];
  let x = 0, y = 0, startX = 0, startY = 0;
  let lastCubic = null, lastQuad = null;
  let command = null;
  while (true) {
    skip();
    if (at >= d.length) break;
    if (/[a-zA-Z]/.test(d[at])) command = d[at++];
    else if (!command) fail(`${piece}: path starts without a command`);
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    const ox = relative ? x : 0, oy = relative ? y : 0;
    let cubic = null, quad = null;
    switch (upper) {
      case 'M': {
        x = ox + readNumber(); y = oy + readNumber();
        startX = x; startY = y;
        out.push(`M ${formatNumber(x)},${formatNumber(y)}`);
        // Further pairs after a moveto are linetos.
        command = relative ? 'l' : 'L';
        break;
      }
      case 'L': x = ox + readNumber(); y = oy + readNumber(); out.push(`L ${formatNumber(x)},${formatNumber(y)}`); break;
      case 'H': x = ox + readNumber(); out.push(`L ${formatNumber(x)},${formatNumber(y)}`); break;
      case 'V': y = oy + readNumber(); out.push(`L ${formatNumber(x)},${formatNumber(y)}`); break;
      case 'C': {
        const x1 = ox + readNumber(), y1 = oy + readNumber(), x2 = ox + readNumber(), y2 = oy + readNumber();
        x = ox + readNumber(); y = oy + readNumber();
        out.push(`C ${formatNumber(x1)},${formatNumber(y1)} ${formatNumber(x2)},${formatNumber(y2)} ${formatNumber(x)},${formatNumber(y)}`);
        cubic = [x2, y2];
        break;
      }
      case 'S': {
        const x1 = lastCubic ? 2 * x - lastCubic[0] : x, y1 = lastCubic ? 2 * y - lastCubic[1] : y;
        const x2 = ox + readNumber(), y2 = oy + readNumber();
        x = ox + readNumber(); y = oy + readNumber();
        out.push(`C ${formatNumber(x1)},${formatNumber(y1)} ${formatNumber(x2)},${formatNumber(y2)} ${formatNumber(x)},${formatNumber(y)}`);
        cubic = [x2, y2];
        break;
      }
      case 'Q': {
        const x1 = ox + readNumber(), y1 = oy + readNumber();
        x = ox + readNumber(); y = oy + readNumber();
        out.push(`Q ${formatNumber(x1)},${formatNumber(y1)} ${formatNumber(x)},${formatNumber(y)}`);
        quad = [x1, y1];
        break;
      }
      case 'T': {
        const x1 = lastQuad ? 2 * x - lastQuad[0] : x, y1 = lastQuad ? 2 * y - lastQuad[1] : y;
        x = ox + readNumber(); y = oy + readNumber();
        out.push(`Q ${formatNumber(x1)},${formatNumber(y1)} ${formatNumber(x)},${formatNumber(y)}`);
        quad = [x1, y1];
        break;
      }
      case 'A': {
        const rx = readNumber(), ry = readNumber(), turn = readNumber(), large = readFlag(), sweep = readFlag();
        x = ox + readNumber(); y = oy + readNumber();
        out.push(`A ${formatNumber(rx)},${formatNumber(ry)} ${formatNumber(turn)} ${large} ${sweep} ${formatNumber(x)},${formatNumber(y)}`);
        break;
      }
      case 'Z': x = startX; y = startY; out.push('Z'); command = null; break;
      default: fail(`${piece}: path command ${command} is not handled`);
    }
    lastCubic = cubic;
    lastQuad = quad;
    if (upper !== 'Z' && !hasNumber() && at < d.length && !/[a-zA-Z]/.test(d[at])) fail(`${piece}: stray text in path`);
  }
  return out.join(' ');
}

function circlePath(cx, cy, r) {
  const left = formatNumber(cx - r), right = formatNumber(cx + r), radius = formatNumber(r), middle = formatNumber(cy);
  return `M ${left},${middle} A ${radius},${radius} 0 1 1 ${right},${middle} A ${radius},${radius} 0 1 1 ${left},${middle} Z`;
}

function convert(piece, svg) {
  const layers = [];
  const stack = [{ ...DEFAULTS }];
  for (const [tag] of svg.matchAll(/<\/?[a-zA-Z][^>]*>/g)) {
    if (tag.startsWith('</')) {
      if (tag === '</g>') stack.pop();
      continue;
    }
    const name = /^<([a-zA-Z]+)/.exec(tag)[1];
    const own = readAttributes(tag, piece);
    const style = { ...stack[stack.length - 1] };
    for (const key of INHERITED) if (own[key] !== undefined) style[key] = own[key];
    if (name === 'svg') {
      if (!/viewBox="0 0 45 45"/.test(tag)) fail(`${piece}: viewBox is not 0 0 45 45`);
      continue;
    }
    if (name === 'g') {
      if (!tag.endsWith('/>')) stack.push(style);
      continue;
    }
    let data;
    if (name === 'path') data = normalisePath(own.d ?? fail(`${piece}: path without d`), piece);
    else if (name === 'circle') data = circlePath(Number(own.cx), Number(own.cy), Number(own.r));
    else fail(`${piece}: element <${name}> is not handled`);
    layers.push([
      piece, layers.length, toArgb(style.fill, piece), toArgb(style.stroke, piece), style['stroke-width'],
      style['stroke-linecap'], style['stroke-linejoin'], style['fill-rule'] === 'evenodd' ? 'F0' : 'F1', data,
    ].join('|'));
  }
  if (!layers.length) fail(`${piece}: no shapes`);
  return layers;
}

const lines = [
  '# Chess pieces "cburnett" by Colin M.L. Burnett, GPLv2+.',
  '# Source: https://github.com/lichess-org/lila/tree/master/public/piece/cburnett',
  '# Converted by tools/build-pieces.mjs into WPF path markup on a 45 by 45 square.',
  '# piece|layer|fill|stroke|strokeWidth|lineCap|lineJoin|fillRule|data',
];
for (const piece of PIECES) {
  let svg;
  if (args.src) svg = readFileSync(join(args.src, `${piece}.svg`), 'utf8');
  else {
    const response = await fetch(`${SOURCE}/${piece}.svg`);
    if (!response.ok) fail(`${piece}: download failed (${response.status})`);
    svg = await response.text();
  }
  const layers = convert(piece, svg);
  console.log(`${piece}: ${layers.length} layers`);
  lines.push(...layers);
}
const text = lines.join('\n') + '\n';
if (/[^\x09\x0a\x20-\x7e]/.test(text)) fail('output is not plain ASCII');
writeFileSync(args.out, text, 'ascii');
console.log(`wrote ${lines.length - 4} layers, ${text.length} bytes to ${args.out}`);
