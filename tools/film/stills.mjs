/* stills of the film at given seconds: node tools/film/stills.mjs <wide|tall> <outdir> 0,2.5,4 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [cut = 'wide', outDir = 'stills', list = '0'] = process.argv.slice(2);
const SITE = process.env.SITE || 'http://localhost:8123';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9342;
const SIZE = { wide: [1280, 720], tall: [400, 866] }[cut];
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'stills-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`,
  '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
for(let i = 0; i < 50; i++){ try{ await fetch(`http://localhost:${PORT}/json/version`); break; }catch(_){ await sleep(200); } }
try{
  const t = await (await fetch(`http://localhost:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const wait = new Map();
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if(d.id && wait.has(d.id)){ const [res, rej] = wait.get(d.id); wait.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); }
    else if(d.method === 'Runtime.exceptionThrown') console.error('page error', JSON.stringify(d.params.exceptionDetails).slice(0, 600));
    else if(d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') console.error('console', JSON.stringify(d.params.args).slice(0, 400));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; wait.set(i, [res, rej]); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result.value; };
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: SIZE[0], height: SIZE[1], deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${SITE}/index.html?film&v=${Date.now()}` });
  for(let i = 0; i < 600; i++){ await sleep(500); if(await ev('!!window.__film')) break; }
  const fps = await ev('__film.fps');
  if(list === 'track'){
    const tr = await ev(`(()=>{ const out = []; const c = window.__book.film.camera; for(let i=0;i<__film.frames;i++){ __film.run(i); out.push([...c.position.toArray(), ...new window.__book.film.THREE.Vector3(0,0,-1).applyQuaternion(c.quaternion).toArray()]); } return out; })()`);
    fs.writeFileSync(path.join(outDir, 'track.json'), JSON.stringify(tr));
    let vmax = 0, amax = 0, at = 0, wmax = 0, wat = 0;
    for(let i = 2; i < tr.length; i++){
      const v = Math.hypot(...[0,1,2].map(k => tr[i][k] - tr[i-1][k]))*fps;
      const w = Math.hypot(...[3,4,5].map(k => tr[i][k] - tr[i-1][k]))*fps;
      if(v > vmax){ vmax = v; at = i/fps; }
      if(w > wmax){ wmax = w; wat = i/fps; }
    }
    const secs = [];
    for(let i = 1; i < tr.length; i += 6) secs.push((i/fps).toFixed(1) + ':' + (Math.hypot(...[0,1,2].map(k => tr[i][k] - tr[i-1][k]))*fps).toFixed(1) + '/' + (Math.hypot(...[3,4,5].map(k => tr[i][k] - tr[i-1][k]))*fps).toFixed(2));
    console.log('peak speed', vmax.toFixed(2), 'at', at.toFixed(2), 'peak turn', wmax.toFixed(2), 'at', wat.toFixed(2));
    console.log(secs.join('  '));
    ws.close(); process.exit(0);
  }
  const total = await ev('__film.frames');
  const want = new Set(list === 'all' ? [...Array(total).keys()] : list.split(',').map(s => Math.round(parseFloat(s)*fps)));
  const last = Math.max(...want);
  for(let i = 0; i <= last; i++){
    if(want.has(i)){
      await ev(`__film.shot(${i})`);
      const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
      if(process.env.PROBE) console.log((i/fps).toFixed(2), JSON.stringify(await ev(process.env.PROBE)));
      fs.writeFileSync(path.join(outDir, list === 'all' ? `f${String(i).padStart(4, '0')}.jpg` : `${cut}_${(i/fps).toFixed(2)}.jpg`), Buffer.from(r.data, 'base64'));
    }else await ev(`__film.run(${i})`);
  }
  ws.close();
}finally{ chrome.kill(); }
