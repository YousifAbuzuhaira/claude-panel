#!/usr/bin/env node
// Screenshots for checking the look, with Playwright's Chromium (no download: it uses
// playwright-core and a Chromium that are already on the machine).
//
//   node shoot.mjs page OUT.png URL [--width 1280] [--height 860] [--wait SELECTOR] [--eval JS] [--full]
//       a web page (Learn, the games) as a person sees it
//   node shoot.mjs file OUT.png PAGE.html [--width 340] [--height 600] [--eval JS] [--selector CSS]
//       a local page such as mac/panel.html; --eval calls its own entry points, e.g.
//       --eval "setAppearance({...}); render({...})"
//   node shoot.mjs sheet OUT.png [--title TEXT] [--cols 2] LABEL=IMAGE.png ...
//       a contact sheet: each image over a dark terminal-like backdrop and a light one,
//       so a see-through background is judged against what it really sits on
//
// PLAYWRIGHT_CORE (a playwright-core folder) and CHROMIUM (an executable) override the defaults.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function findPlaywright() {
  if (process.env.PLAYWRIGHT_CORE) return process.env.PLAYWRIGHT_CORE;
  const store = join(homedir(), 'keops/infra/keops-ai-monorepo/node_modules/.pnpm');
  const found = existsSync(store) ? readdirSync(store).filter(name => name.startsWith('playwright-core@')).sort().pop() : null;
  if (!found) throw new Error('playwright-core not found: set PLAYWRIGHT_CORE');
  return join(store, found, 'node_modules/playwright-core');
}

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = join(homedir(), '.cache/ms-playwright');
  const shells = existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort() : [];
  for (const shell of shells.reverse()) {
    const binary = join(cache, shell, 'chrome-headless-shell-linux64/chrome-headless-shell');
    if (existsSync(binary)) return binary;
  }
  throw new Error('no cached Chromium: set CHROMIUM');
}

function options(args) {
  const named = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--full') named.full = true;
    else if (args[i].startsWith('--')) named[args[i].slice(2)] = args[++i];
    else rest.push(args[i]);
  }
  return { named, rest };
}

const BACKDROP_LOG = [
  '$ pnpm test --filter vault-accounting',
  ' RUN  v3.2.6 /home/yousif/keops/infra/keops-ai-monorepo',
  ' ✓ src/ledger.test.ts (14 tests) 22ms',
  ' ✓ src/fx.test.ts (9 tests) 12ms',
  ' ❯ src/review.test.ts (6 tests | 1 failed) 31ms',
  '   × groups docs first 8ms',
  "     → expected 'docs' to be 'contracts'",
  ' Test Files  1 failed | 2 passed (3)',
  '      Tests  1 failed | 28 passed (29)',
  '● Reading apps/vault/vault-accounting/web/app/review/page.tsx',
  '● Edit apps/vault/vault-accounting/web/app/review/group.tsx',
  '  + const order = [\'docs\', \'contracts\', \'invoices\']',
].join('\n');

function sheetHtml(title, cols, items) {
  const cells = items.map(({ label, src }) => `
    <figure>
      <figcaption>${label}</figcaption>
      <div class="pair">
        <div class="dark"><pre>${BACKDROP_LOG.repeat(6)}</pre><img src="${src}"></div>
        <div class="light"><pre>${BACKDROP_LOG.repeat(6)}</pre><img src="${src}"></div>
      </div>
    </figure>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 16px; background: #0b0b0d; color: #ddd; font: 13px 'Segoe UI', sans-serif; }
    h1 { font-size: 15px; margin: 0 0 12px; }
    .grid { display: grid; grid-template-columns: repeat(${cols}, max-content); gap: 18px; align-items: start; }
    figure { margin: 0; }
    figcaption { margin-bottom: 6px; color: #aaa; }
    .pair { display: flex; gap: 8px; }
    .pair > div { position: relative; padding: 14px; overflow: hidden; border-radius: 6px; }
    .dark { background: #101114; }
    .light { background: #f2efe8; }
    pre { position: absolute; inset: 0; margin: 0; padding: 6px; font: 12px/1.35 'Cascadia Mono', monospace; white-space: pre-wrap; }
    .dark pre { color: #7d9a7d; }
    .light pre { color: #6a5a48; }
    img { position: relative; display: block; image-rendering: auto; }
  </style><h1>${title}</h1><div class="grid">${cells}</div>`;
}

async function main() {
  const [mode, out, ...args] = process.argv.slice(2);
  if (!mode || !out) {
    console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 15).join('\n'));
    process.exit(2);
  }
  const require = createRequire(import.meta.url);
  const { chromium } = require(findPlaywright());
  const browser = await chromium.launch({ executablePath: findChromium() });
  try {
    const { named, rest } = options(args);
    const width = Number(named.width || (mode === 'file' ? 340 : 1280));
    const height = Number(named.height || (mode === 'file' ? 600 : 860));
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: Number(named.scale || 1) });
    page.on('pageerror', error => console.error(`page error: ${error.message}`));
    if (mode === 'sheet') {
      const items = rest.map(item => {
        const at = item.indexOf('=');
        const label = at > 0 ? item.slice(0, at) : basename(item);
        const file = resolve(at > 0 ? item.slice(at + 1) : item);
        return { label, src: `data:image/png;base64,${readFileSync(file).toString('base64')}` };
      });
      await page.setContent(sheetHtml(named.title || '', Number(named.cols || 1), items));
      await page.screenshot({ path: out, fullPage: true });
    } else {
      const target = mode === 'file' ? pathToFileURL(resolve(rest[0])).href : rest[0];
      await page.goto(target, { waitUntil: 'load' });
      if (named.wait) await page.waitForSelector(named.wait, { timeout: 15000 });
      if (named.eval) await page.evaluate(named.eval);
      await page.waitForTimeout(Number(named.settle || 300));
      if (named.selector) await page.locator(named.selector).screenshot({ path: out, omitBackground: true });
      else await page.screenshot({ path: out, fullPage: Boolean(named.full), omitBackground: mode === 'file' });
    }
    console.log(out);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
