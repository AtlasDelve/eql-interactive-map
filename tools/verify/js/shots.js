#!/usr/bin/env node
'use strict';

// Human-review screenshots from one self-contained user artifact.
// Usage: node shots.js <artifact.html> <empty-outdir>
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');

const CANDIDATES = [
  process.env.EQL_BROWSER,
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/brave-browser', '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);
const BROWSER = CANDIDATES.find((candidate) => {
  try { return fs.existsSync(candidate); } catch { return false; }
});

function fail(message) { throw new Error(message); }

async function canvasDelta(page) {
  return page.evaluate(() => {
    const image = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const background = [15, 22, 32]; // drawCont's #0f1620
    let total = 0, changed = 0;
    for (let i = 0; i < image.length; i += 4) {
      const delta = Math.abs(image[i] - background[0])
        + Math.abs(image[i + 1] - background[1])
        + Math.abs(image[i + 2] - background[2]);
      total += delta;
      if (delta) changed++;
    }
    return { mad: total / (image.length / 4), changed, pixels: image.length / 4 };
  });
}

(async () => {
  const artifactArg = process.argv[2], outArg = process.argv[3];
  if (!artifactArg || !outArg) fail('usage: node shots.js <artifact.html> <empty-outdir>');
  const artifact = path.resolve(artifactArg), outdir = path.resolve(outArg);
  if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) fail('artifact not found: ' + artifact);
  if (fs.existsSync(outdir)) {
    if (!fs.statSync(outdir).isDirectory()) fail('output path is not a directory: ' + outdir);
    if (fs.readdirSync(outdir).length) fail('refusing non-empty output directory: ' + outdir);
  } else {
    fs.mkdirSync(outdir, { recursive: true });
  }
  if (!BROWSER) fail('no Chromium-family browser found; set EQL_BROWSER=/path/to/browser');

  console.log('browser: ' + BROWSER);
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push('pageerror: ' + error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push('console.error: ' + message.text());
    });
    await page.goto(pathToFileURL(artifact).href, { waitUntil: 'load', timeout: 120000 });
    await page.evaluate(() => setXpac(XPACS.order[XPACS.order.length - 1]));

    const continents = await page.evaluate(() => Object.keys(ALL));
    await page.evaluate(() => { enterWorld(); document.getElementById('bFit').click(); });
    await page.screenshot({ path: path.join(outdir, 'world.png') });
    console.log('PASS world.png');

    for (const name of continents) {
      const state = await page.evaluate(continent => {
        enterCont(continent);
        document.getElementById('bFit').click();
        return {
          cur, level,
          title: document.getElementById('title').textContent,
          zones: Object.keys(ALL[continent].zones).length,
        };
      }, name);
      if (state.cur !== name || state.level !== 'continent') {
        fail(`enterCont refused ${name}: level=${state.level} cur=${state.cur}`);
      }
      if (state.title !== name) fail(`HUD title mismatch for ${name}: ${state.title}`);
      const pixels = await canvasDelta(page);
      if (state.zones) {
        if (!(pixels.mad > 0.01 && pixels.changed > 0)) {
          fail(`${name} canvas is blank: ${JSON.stringify(pixels)}`);
        }
      } else if (pixels.changed !== 0) {
        fail(`${name} expected blank-map canvas: ${JSON.stringify(pixels)}`);
      }
      await page.screenshot({ path: path.join(outdir, name + '.png') });
      console.log(`PASS ${name}.png (${state.zones ? `canvas MAD ${pixels.mad.toFixed(3)}` : 'blank map; HUD named'})`);
    }
    if (errors.length) fail(errors.join('\n'));
    const pngs = fs.readdirSync(outdir).filter(name => name.toLowerCase().endsWith('.png'));
    if (pngs.length !== continents.length + 1) fail(`wrote ${pngs.length} PNGs, expected ${continents.length + 1}`);
    console.log(`RESULT: PASS (${pngs.length} PNGs in ${outdir})`);
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error('RESULT: FAIL\n' + (error.stack || error));
  process.exitCode = 1;
});
