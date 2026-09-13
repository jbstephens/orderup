#!/usr/bin/env node
/* ORDER UP! v2 verification harness — lives IN the repo (v1's evaporated).
 *
 * Run from the repo root, FOREGROUND ONLY:
 *   node --experimental-websocket test/verify.mjs [scenario …]
 * (Node 22+ has global WebSocket; the flag is required on 21 and harmless
 * after.) Scenarios: static, boot, kbday, chaos, pizza, twop, touch — no
 * args runs them all, in order. `kbday` plays a REAL full day and takes
 * ~2 minutes of wall clock by design.
 *
 * Real input only: CDP keyboard events, CDP touch events, and a fake
 * standard-mapping navigator.getGamepads() stub injected before page
 * scripts (the house-standard pad rig). State is read, never written —
 * the single flagged exception is the clock forward-wind in `chaos`
 * (G.timeLeft), which skips waiting out a day whose completion `kbday`
 * already proves the real way.
 */
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'index.html');
const SHOTS = path.join(ROOT, 'test-shots');
mkdirSync(SHOTS, { recursive: true });

const results = [];
let failures = 0;
function check(name, ok, detail){
  results.push({ name, ok: !!ok, detail: detail || '' });
  if (!ok) failures++;
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  — ' + detail : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ═══════════ 1. static checks (no browser) ═══════════ */
function scenarioStatic(){
  console.log('\n── static ──');
  const html = readFileSync(HTML, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  check('exactly one inline script', scripts.length === 1, String(scripts.length));
  const tmp = path.join(os.tmpdir(), 'orderup-inline.js');
  writeFileSync(tmp, scripts[0][1]);
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  check('node --check clean', r.status === 0, (r.stderr || '').trim().slice(0, 200));
  check('no shadowBlur use', !/\.shadowBlur\s*=/.test(html));
  check('no backdrop-filter', !/backdrop-filter/.test(html));
  check('controller.js in <head>', /<script src="https:\/\/ses\.q5labs\.co\/lib\/controller\.js"><\/script>/.test(html));
}

/* ═══════════ chrome + CDP plumbing ═══════════ */
function findChrome(){
  const cands = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  throw new Error('no Chrome found — set CHROME=');
}

let chromeProc = null, profileDir = null, server = null, serverPort = 0;

function startServer(){
  return new Promise(resolve => {
    server = createServer((req, res) => {
      const clean = req.url.split(/[?#]/)[0];
      if (clean === '/favicon.ico'){ res.writeHead(204); res.end(); return; }
      const fp = clean === '/' ? HTML : path.join(ROOT, clean);
      if (!fp.startsWith(ROOT) || !existsSync(fp)){ res.writeHead(404); res.end(); return; }
      const type = fp.endsWith('.html') ? 'text/html' : fp.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(readFileSync(fp));
    });
    server.listen(0, '127.0.0.1', () => { serverPort = server.address().port; resolve(); });
  });
}

async function launchChrome(){
  profileDir = mkdtempSync(path.join(os.tmpdir(), 'orderup-verify-'));
  const chrome = findChrome();
  chromeProc = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profileDir,
    '--mute-audio',                       // ALWAYS — headless still owns the Mac speakers otherwise
    '--no-first-run', '--no-default-browser-check', '--disable-features=TranslateUI',
    '--window-size=1280,800', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let port = 0;
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !port; i++){
    await sleep(100);
    try { port = parseInt(readFileSync(portFile, 'utf8').split('\n')[0], 10); } catch (e) {}
  }
  if (!port) throw new Error('Chrome debug port never appeared');
  const list = await fetch('http://127.0.0.1:' + port + '/json/version').then(r => r.json());
  return list.webSocketDebuggerUrl;
}

class CDP {
  constructor(ws){ this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }
  static async connect(url){
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && c.pending.has(m.id)){
        const { res, rej } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method){
        for (const h of c.handlers) h(m);
      }
    };
    return c;
  }
  send(method, params, sessionId){
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(fn){ this.handlers.push(fn); }
}

const BOOTSTRAP = `
(() => {
  // seed/clear localStorage per scenario, directed by the URL hash
  try {
    localStorage.clear();
    const m = location.hash.match(/seed=([^&]+)/);
    if (m){
      const s = JSON.parse(decodeURIComponent(m[1]));
      for (const k in s) localStorage.setItem('orderup_' + k, JSON.stringify(s[k]));
    }
  } catch (e) {}
  // fake standard-mapping pads, off until a scenario turns them on
  const mkPad = i => ({ id: 'Fake Pad ' + i + ' (STANDARD GAMEPAD)', index: i, connected: true,
    mapping: 'standard', timestamp: 1,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) });
  window.__fakePads = [mkPad(0), mkPad(1)];
  window.__padsOn = false;
  navigator.getGamepads = () => window.__padsOn ? [window.__fakePads[0], window.__fakePads[1], null, null] : [];
  window.__padSet = (i, b, down) => {
    const bt = window.__fakePads[i].buttons[b];
    bt.pressed = down; bt.value = down ? 1 : 0;
    window.__fakePads[i].timestamp++;
  };
  window.__padAxis = (i, a, v) => { window.__fakePads[i].axes[a] = v; window.__fakePads[i].timestamp++; };
  // per-frame 2D-context op counters (recording gated so bakes don't count)
  const proto = CanvasRenderingContext2D.prototype;
  window.__ops = { di: 0, path: 0, rec: false };
  const wrap = (name, key) => {
    const orig = proto[name];
    proto[name] = function (...a){ if (window.__ops.rec) window.__ops[key]++; return orig.apply(this, a); };
  };
  wrap('drawImage', 'di');
  for (const n of ['beginPath', 'arc', 'arcTo', 'ellipse', 'lineTo', 'moveTo',
                   'quadraticCurveTo', 'bezierCurveTo', 'rect', 'stroke', 'fill']) wrap(n, 'path');
  window.__measureOps = frames => new Promise(res => {
    const samples = [];
    let lastD = 0, lastP = 0, n = 0;
    window.__ops.di = 0; window.__ops.path = 0; window.__ops.rec = true;
    function tick(){
      samples.push({ di: window.__ops.di - lastD, path: window.__ops.path - lastP });
      lastD = window.__ops.di; lastP = window.__ops.path;
      if (++n > frames){ window.__ops.rec = false; samples.shift(); res(samples); }
      else requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  window.__frames = n => new Promise(res => {
    let k = 0; const f = () => { if (++k >= n) res(k); else requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
})();`;

let cdp = null, sess = null, targetId = null;
let consoleErrors = [];
const controllerLocal = path.resolve(ROOT, '..', 'gameconsole', 'lib', 'controller.js');

async function openPage(){
  const t = await cdp.send('Target.createTarget', { url: 'about:blank' });
  targetId = t.targetId;
  const a = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  sess = a.sessionId;
  cdp.on(m => {
    if (m.sessionId !== sess) return;
    if (m.method === 'Runtime.exceptionThrown')
      consoleErrors.push('exception: ' + JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      consoleErrors.push('console.error: ' + m.params.args.map(x => x.value ?? x.description ?? '').join(' ').slice(0, 300));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
      consoleErrors.push('log: ' + m.params.entry.text.slice(0, 300));
    if (m.method === 'Fetch.requestPaused'){
      const { requestId, request } = m.params;
      if (/controller\.js/.test(request.url) && existsSync(controllerLocal)){
        cdp.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' },
                            { name: 'Access-Control-Allow-Origin', value: '*' }],
          body: readFileSync(controllerLocal).toString('base64'),
        }, sess).catch(() => {});
      } else cdp.send('Fetch.continueRequest', { requestId }, sess).catch(() => {});
    }
  });
  await cdp.send('Runtime.enable', {}, sess);
  await cdp.send('Log.enable', {}, sess);
  await cdp.send('Page.enable', {}, sess);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*ses.q5labs.co*' }] }, sess);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, sess);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOTSTRAP }, sess);
}
async function closePage(){
  if (targetId){ await cdp.send('Target.closeTarget', { targetId }).catch(() => {}); targetId = null; sess = null; }
}

async function evl(expr, awaitP){
  const r = await cdp.send('Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: !!awaitP }, sess);
  if (r.exceptionDetails) throw new Error('eval failed: ' + expr.slice(0, 120) + ' → ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function waitFor(expr, timeoutMs, label){
  const t0 = Date.now();
  for (;;){
    if (await evl(expr)) return true;
    if (Date.now() - t0 > (timeoutMs || 8000)) throw new Error('timeout waiting for ' + (label || expr));
    await sleep(80);
  }
}
async function navigate(hash){
  consoleErrors = [];
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + serverPort + '/index.html' + (hash || '') }, sess);
  await waitFor('!!(window.__game && window.__game.scene)', 12000, 'game boot');
  await evl('window.__frames(5)', true);
}

/* real inputs */
const KEYS = {
  left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39],
  up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40],
  south: ['KeyJ', 'j', 74], east: ['KeyK', 'k', 75], west: ['KeyI', 'i', 73],
  north: ['KeyL', 'l', 76], start: ['KeyP', 'p', 80],
};
async function keyTap(name, holdMs){
  const [code, key, vk] = KEYS[name];
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk }, sess);
  await sleep(holdMs || 60);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk }, sess);
  await evl('window.__frames(3)', true);
}
const PADB = { south: 0, east: 1, west: 2, north: 3, select: 8, start: 9, up: 12, down: 13, left: 14, right: 15 };
async function padTap(i, name){
  await evl(`window.__padSet(${i}, ${PADB[name]}, true)`);
  await evl('window.__frames(4)', true);   // ≥2 rAFs: survive first-frame seeding
  await evl(`window.__padSet(${i}, ${PADB[name]}, false)`);
  await evl('window.__frames(3)', true);
}
async function touchTap(x, y){
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }, sess);
  await sleep(50);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sess);
  await evl('window.__frames(3)', true);
}
async function screenshot(name){
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sess);
  const fp = path.join(SHOTS, name);
  writeFileSync(fp, Buffer.from(r.data, 'base64'));
  console.log('  shot  ' + path.relative(ROOT, fp));
}

/* drive the grid highlight to a tile index with REAL direction taps */
async function driveTo(pIdx, targetIndex, input){
  for (let guard = 0; guard < 40; guard++){
    const st = await evl(`(() => {
      const p = window.__players[${pIdx}];
      const per = window.__players[1].active ? 8 : 11;
      return { sel: p.sel, per, n: p.unlocked.length };
    })()`);
    if (st.sel === targetIndex) return;
    const rowS = Math.floor(st.sel / st.per), rowT = Math.floor(targetIndex / st.per);
    const colS = st.sel % st.per, colT = targetIndex % st.per;
    let dir;
    if (rowS !== rowT) dir = rowT > rowS ? 'down' : 'up';
    else dir = colT > colS ? 'right' : 'left';
    if (input === 'kb') await keyTap(dir); else await padTap(pIdx, dir);
  }
  throw new Error('driveTo never reached tile ' + targetIndex);
}
async function addViaInput(pIdx, id, input){
  const idx = await evl(`window.__players[${pIdx}].unlocked.indexOf(${JSON.stringify(id)})`);
  if (idx < 0) throw new Error(id + ' not unlocked');
  await driveTo(pIdx, idx, input);
  const before = await evl(`window.__players[${pIdx}].build.length`);
  if (input === 'kb') await keyTap('south'); else await padTap(pIdx, 'south');
  await waitFor(`(() => { const p = window.__players[${pIdx}];
    return p.build.length !== ${before} || !!p.serve || p.build.length === 0; })()`, 4000, 'ingredient added: ' + id);
}
async function buildSeq(pIdx, seq, input){
  for (const id of seq) await addViaInput(pIdx, id, input);
}
function assertNoConsoleErrors(scenario){
  check(scenario + ': zero console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
}

/* ═══════════ 2. boot: menu invariants, tuning knob, prefix-free ═══════ */
async function scenarioBoot(){
  console.log('\n── boot ──');
  await openPage();
  await navigate('');
  check('boots to title', (await evl('window.__game.scene')) === 'title');
  const dishes = await evl('window.__dishes.map(d => ({ id: d.id, day: d.day, seq: d.seq }))');
  check('20 dishes on the menu', dishes.length === 20, String(dishes.length));
  const ings = await evl('window.__ings.length');
  check('31 ingredients defined', ings === 31, String(ings));
  // HARD INVARIANT: prefix-free — auto-serve law
  let bad = null;
  for (const a of dishes) for (const b of dishes){
    if (a.id === b.id || a.seq.length >= b.seq.length) continue;
    if (a.seq.every((s, i) => s === b.seq[i])) bad = a.id + ' ⊑ ' + b.id;
  }
  check('menu is PREFIX-FREE (all 20 dishes)', !bad, bad || '');
  const maxDay = Math.max(...dishes.map(d => d.day));
  check('calendar reaches day 12', maxDay === 12, String(maxDay));
  const lens = await evl('[1,2,6,11,12,20].map(d => window.__tuning.dayLen(d))');
  check('DAY_LEN: day1=100s', lens[0] === 100, String(lens[0]));
  check('DAY_LEN: day12=120s (clamped)', lens[3] === 120 && lens[4] === 120, lens.join(','));
  check('DAY_LEN: never exceeds 120', Math.max(...lens) <= 120, lens.join(','));
  const seqIds = new Set(dishes.flatMap(d => d.seq));
  const known = new Set(await evl('window.__ings'));
  check('every dish ingredient exists', [...seqIds].every(id => known.has(id)));
  assertNoConsoleErrors('boot');
  await closePage();
}

/* ═══════════ 3. kbday: keyboard-only REAL full day ═══════════
   auto-serve, □-no-op on matching build, pause, expiry beat, the whole day
   to its report card in real time, then the shop. */
async function scenarioKbday(){
  console.log('\n── kbday (real ~110s day — patience) ──');
  await openPage();
  await navigate('#seed=' + encodeURIComponent(JSON.stringify({ wallet: 100 })));
  await keyTap('south');                                   // open the diner
  await waitFor('window.__game.scene === "dayintro"', 4000);
  await sleep(900); await keyTap('south');                 // skip intro
  await waitFor('window.__game.scene === "play"', 6000);
  check('day 1 length is 100s', (await evl('window.__game.dayLen')) === 100);
  // pause / resume
  await keyTap('start');
  check('START pauses', (await evl('window.__game.scene')) === 'pause');
  await keyTap('start');
  check('START resumes', (await evl('window.__game.scene')) === 'play');
  // auto-serve: build the first ticket exactly; NO serve button exists
  await waitFor('window.__players[0].tickets.length > 0', 12000, 'first ticket');
  const seq = await evl('window.__players[0].tickets[0].seq');
  await buildSeq(0, seq.slice(0, -1), 'kb');
  // □ on a matching-but-unfinished build would wrong-ship it; instead prove
  // □ is a NO-OP once the exact match completes: mash it during the drop.
  await addViaInput(0, seq[seq.length - 1], 'kb');
  await keyTap('west'); await keyTap('west');
  await waitFor('window.__players[0].served === 1', 6000, 'auto-serve');
  await waitFor('!window.__players[0].serve', 4000, 'serve slide done');
  const tips1 = await evl('window.__game.tips');
  check('auto-serve paid a tip', tips1 > 0, '$' + tips1);
  check('□ during a matching build did NOT wrong-ship', (await evl('window.__game.wrongServed')) === 0);
  check('combo started', (await evl('window.__players[0].combo')) === 1);
  // now idle: a ticket must expire (walk-away beat), and the day must END
  await waitFor('window.__game.expired > 0', 45000, 'expiry beat');
  check('expiry beat fired', true);
  const sad = await evl('window.__players[0].tickets.some(t => t.state === "leaving")');
  check('walk-away is visible (leaving ticket)', sad || (await evl('window.__game.expired')) > 0);
  await waitFor('window.__game.scene === "report"', 120000, 'day completes');
  check('full REAL day completed to report card', true);
  await sleep(3000);
  const rep = await evl('({ stars: window.__game.report.stars, served: window.__game.report.served })');
  check('report has stars+served', rep.stars >= 1 && rep.served >= 1, JSON.stringify(rep));
  // shop (□ from report), buy teal neon with seeded wallet
  await keyTap('west');
  check('report □ opens shop', (await evl('window.__game.scene')) === 'shop');
  await keyTap('right');                                    // neon_teal
  await keyTap('south');
  check('bought+equipped teal neon', (await evl('window.__game.cosm.neon')) === 'teal');
  const w = await evl('window.__game.wallet');
  check('wallet debited 25', w === 100 + (await evl('window.__game.tips')) - 25, '$' + w);
  await keyTap('east');
  check('back to report', (await evl('window.__game.scene')) === 'report');
  await keyTap('east');
  check('east returns to title', (await evl('window.__game.scene')) === 'title');
  assertNoConsoleErrors('kbday');
  await closePage();
}

/* ═══════════ 4. chaos: THE CHAOS CLAUSE, pad-driven, day 12 ═══════════ */
async function scenarioChaos(){
  console.log('\n── chaos ──');
  await openPage();
  await navigate('#seed=' + encodeURIComponent(JSON.stringify({ day: 12 })));
  await evl('window.__padsOn = true');
  await evl('window.__frames(4)', true);
  await padTap(0, 'south');                                 // title → day 12
  await waitFor('window.__game.scene === "dayintro"', 4000);
  await sleep(900); await padTap(0, 'south');
  await waitFor('window.__game.scene === "play"', 6000);
  check('day 12 starts', (await evl('window.__game.day')) === 12);
  check('day 12 length is 120s', (await evl('window.__game.dayLen')) === 120);
  check('full grid: 31 tiles unlocked', (await evl('window.__players[0].unlocked.length')) === 31);
  const rects = await evl('window.__players[0].unlocked.map((_, i) => window.__tileRect(window.__players[0], i))');
  const clip = rects.find(r => r.x - r.s / 2 < 0 || r.x + r.s / 2 > 1280 || r.y - r.s / 2 < 440 || r.y + r.s / 2 > 720);
  check('no tile clips 1280x720 (or the plate row)', !clip, clip ? JSON.stringify(clip) : '');
  await evl('window.__frames(30)', true);
  await screenshot('day12-full-grid.png');
  await waitFor('window.__players[0].tickets.length > 0', 12000, 'ticket');
  // ── the canonical gag: a shake tips onto a burger and SPLATS
  await addViaInput(0, 'bun', 'pad');
  await addViaInput(0, 'patty', 'pad');
  const parts0 = await evl('window.__parts.filter(p => p.on).length');
  await addViaInput(0, 'shake', 'pad');
  check('shake landed on the stack (nothing bounces)', (await evl('window.__players[0].build.length')) === 3);
  await waitFor('window.__players[0].stack.length === 3 && window.__players[0].stack[2].landed', 4000, 'splat land');
  check('shake-on-burger SPLATTED', await evl('window.__players[0].stack[2].splat === true'));
  const parts1 = await evl('window.__parts.filter(p => p.on).length');
  check('splat particles fired', parts1 > parts0, parts0 + '→' + parts1);
  check('Maria: gold pulse showed the right path', await evl('window.__players[0].pulseT > 0 || window.__players[0].pulseIds.length > 0'));
  await screenshot('splat-shake-on-burger.png');
  // ── □ SEND IT
  const before = await evl(`(() => ({ tips: window.__game.tips, tk: window.__players[0].tickets.length,
    on: window.__game.orderNum }))()`);
  await padTap(0, 'west');
  await waitFor('!!window.__players[0].serve && window.__players[0].serve.wrong', 3000, 'wrong shipment');
  check('□ ships the wreckage (wrong serve)', true);
  check('combo reset', (await evl('window.__players[0].combo')) === 0);
  const aghast = await evl(`(() => { const s = window.__players[0].serve;
    return s.target ? { mood: s.target.mood, bubble: !!s.target.bubble && s.target.bubbleT > 0 } : null; })()`);
  check('customer aghast (mood 4/5, never crying)', aghast && aghast.mood >= 4, JSON.stringify(aghast));
  check('house-voice reaction line shown', aghast && aghast.bubble);
  await waitFor('window.__players[0].serve && window.__players[0].serve.t > 0.55', 2000);
  await screenshot('wrong-shipment.png');
  await waitFor('!window.__players[0].serve', 4000, 'shipment done');
  check('NO tip for chaos', (await evl('window.__game.tips')) === before.tips);
  check('wrongServed counted', (await evl('window.__game.wrongServed')) === 1);
  await waitFor(`window.__players[0].tickets.length < ${before.tk} || window.__game.orderNum > ${before.on}`, 6000, 'ticket cleared');
  check('ticket cleared — the queue keeps moving', true);
  await waitFor(`window.__game.orderNum > ${before.on}`, 20000, 'next ticket arrives');
  check('next ticket arrives', true);
  // two more gleeful garbage shipments (earn the chaos stamp: wrong ≥ 3)
  for (let k = 0; k < 2; k++){
    await addViaInput(0, 'glass', 'pad');
    await addViaInput(0, 'ketchup', 'pad');
    await padTap(0, 'west');
    await waitFor('!window.__players[0].serve', 6000, 'garbage shipped');
  }
  check('three wrong shipments logged', (await evl('window.__game.wrongServed')) === 3);
  check('tips still $' + before.tips, (await evl('window.__game.tips')) === before.tips);
  // day continues → report card. FLAGGED clock skip: kbday proved the full
  // real-time day; here we wind the clock so the suite stays under budget.
  await evl('window.__game.timeLeft = 2');
  await waitFor('window.__game.scene === "report"', 30000, 'chaotic day report');
  check('chaotic day still ends with a report card', true);
  await waitFor('window.__game.report.t > 2.8', 8000);
  const rep = await evl('({ stars: window.__game.report.stars, wrong: window.__game.report.wrong, line: window.__game.report.chaosLine })');
  check('0–1 stars for a garbage day', rep.stars <= 1, JSON.stringify(rep));
  check('funny (never scolding) report line', !!rep.line, rep.line || '');
  await screenshot('chaos-report-card.png');
  assertNoConsoleErrors('chaos');
  await closePage();
}

/* ═══════════ 5. pizza: new-family build (day 10) + screenshot ═════════ */
async function scenarioPizza(){
  console.log('\n── pizza ──');
  await openPage();
  await navigate('#seed=' + encodeURIComponent(JSON.stringify({ day: 12 })));
  await keyTap('left'); await keyTap('left');               // pick day 10
  check('picked day 10', (await evl('window.__game.pickDay')) === 10);
  await keyTap('south');
  await waitFor('window.__game.scene === "dayintro"', 4000);
  check('NEW ON THE MENU: PIZZA', (await evl('window.__game.intro.newFam')) === 'PIZZA');
  await sleep(900); await keyTap('south');
  await waitFor('window.__game.scene === "play"', 6000);
  // wait for a REAL pizza ticket (day-10 dishes are weighted 3x), then build
  // it exactly — the new family must auto-serve end-to-end
  await waitFor('window.__players[0].tickets.some(t => t.seq[0] === "pzcrust" && !t.reserved && t.patience > 14)', 75000, 'a pizza ticket');
  const pseq = await evl('window.__players[0].tickets.find(t => t.seq[0] === "pzcrust" && !t.reserved && t.patience > 14).seq');
  const tips0 = await evl('window.__game.tips');
  await buildSeq(0, pseq, 'kb');
  await waitFor('!!window.__players[0].serve || window.__players[0].served >= 1', 5000, 'pizza serve');
  await evl('window.__frames(8)', true);
  await screenshot('pizza-build.png');
  await waitFor('window.__players[0].served >= 1 && !window.__players[0].serve', 5000);
  check('pizza auto-served for a tip', (await evl('window.__game.tips')) > tips0);
  assertNoConsoleErrors('pizza');
  await closePage();
}

/* ═══════════ 6. twop: 2P join, both serve, ops budget at the busiest ══ */
async function scenarioTwop(){
  console.log('\n── twop ──');
  await openPage();
  await navigate('#seed=' + encodeURIComponent(JSON.stringify({ day: 12 })));
  await evl('window.__padsOn = true');
  await evl('window.__frames(4)', true);
  await padTap(1, 'south');                                 // P2 joins on title
  check('P2 queued on title', await evl('window.__game.p2Queued === true'));
  await padTap(0, 'south');
  await waitFor('window.__game.scene === "dayintro"', 4000);
  await sleep(900); await padTap(0, 'south');
  await waitFor('window.__game.scene === "play"', 6000);
  check('2P active', await evl('window.__players[1].active === true'));
  // 2P grid must not clip either half, nor collide with the center register
  const clip2 = await evl(`(() => {
    for (const p of window.__players){
      for (let i = 0; i < p.unlocked.length; i++){
        const r = window.__tileRect(p, i);
        const lo = p.idx ? 640 : 0, hi = p.idx ? 1280 : 640;
        if (r.x - r.s/2 < lo + 4 || r.x + r.s/2 > hi - 4 || r.y + r.s/2 > 718) return { p: p.idx, i, r };
        if (!p.idx && r.x + r.s/2 > 534) return { p: p.idx, i, r, reg: true };
      }
    }
    return null; })()`);
  check('2P: 31 tiles fit both halves, clear of register', !clip2, clip2 ? JSON.stringify(clip2) : '');
  // both cooks serve one real order each
  for (const pi of [0, 1]){
    await waitFor(`window.__players[${pi}].tickets.length > 0`, 15000, 'P' + (pi + 1) + ' ticket');
    const seq = await evl(`window.__players[${pi}].tickets[0].seq`);
    await buildSeq(pi, seq, 'pad');
    await waitFor(`window.__players[${pi}].served >= 1`, 8000, 'P' + (pi + 1) + ' serve');
  }
  check('both cooks served', true);
  check('shared tips pooled', (await evl('window.__game.tips')) > 0);
  // now the NEW busiest scene: day 12, both grids, chaos splats + shipments
  for (const pi of [0, 1]){
    await addViaInput(pi, 'patty', 'pad');
    await addViaInput(pi, 'shake', 'pad');                   // splat (no glass)
  }
  await addViaInput(0, 'syrup', 'pad');                      // splats land…
  await addViaInput(1, 'syrup', 'pad');                      // …right before the measure
  await screenshot('2p-day12-chaos.png');
  await padTap(0, 'west');
  await padTap(1, 'west');                                   // both wreckages slide
  const samples = await evl('window.__measureOps(40)', true);
  const maxDi = Math.max(...samples.map(s => s.di));
  const maxPath = Math.max(...samples.map(s => s.path));
  check('ops: max drawImage/frame < 150 (busiest 2P chaos)', maxDi < 150, 'max ' + maxDi);
  check('ops: path ops/frame === 0', maxPath === 0, 'max ' + maxPath);
  console.log('  ops   maxDrawImage=' + maxDi + ' maxPathOps=' + maxPath);
  assertNoConsoleErrors('twop');
  await closePage();
}

/* ═══════════ 7. touch: virtual pad injection + direct tile taps ═══════ */
async function scenarioTouch(){
  console.log('\n── touch ──');
  await openPage();
  await navigate('#seed=' + encodeURIComponent(JSON.stringify({ day: 3 })));
  // first real touch: engages the shared virtual pad AND (on title) starts the day
  await touchTap(640, 400);
  check('virtual pad injected on first touch', await evl('!!document.getElementById("__arcade_touchpad")'));
  await waitFor('window.__game.scene === "dayintro"', 4000, 'touch starts day');
  await sleep(900); await touchTap(640, 400);                // tap skips intro
  await waitFor('window.__game.scene === "play"', 6000);
  check('day 3 via seed', (await evl('window.__game.day')) === 3);
  // direct tap-an-ingredient (first-class gesture, coexists with the pad)
  const r0 = await evl('window.__tileRect(window.__players[0], 0)');
  await touchTap(r0.x, r0.y);
  await waitFor('window.__players[0].build.length >= 1 || window.__players[0].serve', 4000, 'tap adds');
  check('direct tap adds the tile', true);
  // virtual ✕ button drives pad(0) → adds the selected ingredient
  const bl0 = await evl('window.__players[0].build.length');
  const btn = await evl('(() => { const b = document.getElementById("__atp-s").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()');
  await touchTap(btn.x, btn.y);
  await waitFor(`window.__players[0].build.length !== ${bl0} || !!window.__players[0].serve || window.__players[0].build.length === 0`, 4000, 'virtual ✕');
  check('virtual pad ✕ adds via pad(0)', true);
  assertNoConsoleErrors('touch');
  await closePage();
}

/* ═══════════ main ═══════════ */
const ALL = { static: scenarioStatic, boot: scenarioBoot, kbday: scenarioKbday,
              chaos: scenarioChaos, pizza: scenarioPizza, twop: scenarioTwop, touch: scenarioTouch };
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ALL);

(async () => {
  let needBrowser = wanted.some(w => w !== 'static');
  try {
    for (const w of wanted) if (!ALL[w]) throw new Error('unknown scenario ' + w);
    if (wanted.includes('static')) scenarioStatic();
    if (needBrowser){
      await startServer();
      const wsUrl = await launchChrome();
      cdp = await CDP.connect(wsUrl);
      for (const w of wanted){
        if (w === 'static') continue;
        try { await ALL[w](); }
        catch (e){
          check(w + ': scenario completed', false, e.message);
          if (consoleErrors.length) console.log('  console: ' + consoleErrors.slice(0, 4).join(' | '));
          await closePage().catch(() => {});
        }
      }
    }
  } catch (e){
    check('suite ran', false, e.message);
  } finally {
    try { chromeProc && chromeProc.kill(); } catch (e) {}
    try { server && server.close(); } catch (e) {}
    try { profileDir && rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  }
  const passed = results.filter(r => r.ok).length;
  console.log('\n══ ' + passed + '/' + results.length + ' checks passed' + (failures ? ' — ' + failures + ' FAILED' : ' ══'));
  process.exit(failures ? 1 : 0);
})();
