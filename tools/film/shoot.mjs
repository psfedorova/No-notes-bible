/* Shoots the opening film (film.js) from the live scene and encodes it.

     python3 -m http.server 8123          (in the repo, if it is not running yet)
     node tools/film/shoot.mjs            (both cuts; or: node tools/film/shoot.mjs wide)

   Starts its own headless Chrome (Metal), steps the film frame by frame, screenshots
   each frame at twice the size and encodes it down with ffmpeg into
   assets/intro/{wide,tall}.mp4 + a first-frame still .jpg, and records the camera's
   first and last pose into assets/intro/poses.json for the hand-over to the live book */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.join(ROOT, 'assets/intro');
const SITE = process.env.SITE || 'http://localhost:8123';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9341;
/* css size, the encoded size; rendered at 2x and scaled down */
const CUTS = {
  wide: { w: 1920, h: 1080, out: [1920, 1080], lite: [960, 540] },
  tall: { w: 600, h: 1300, out: [720, 1560], lite: [480, 1040] }
};
const only = process.argv.slice(2);
const cuts = Object.keys(CUTS).filter(k => !only.length || only.includes(k));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'film-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`,
  '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
for(let i = 0; i < 50; i++){ try{ await fetch(`http://localhost:${PORT}/json/version`); break; }catch(_){ await sleep(200); } }

async function tab(url, w, h){
  const t = await (await fetch(`http://localhost:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const wait = new Map();
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if(d.id && wait.has(d.id)){ const [res, rej] = wait.get(d.id); wait.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); }
    else if(d.method === 'Runtime.exceptionThrown') console.error('page error', JSON.stringify(d.params.exceptionDetails).slice(0, 400));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; wait.set(i, [res, rej]); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  return { send, ev, close: () => ws.close() };
}

fs.mkdirSync(OUT, { recursive: true });
const posesFile = path.join(OUT, 'poses.json');
const poses = fs.existsSync(posesFile) ? JSON.parse(fs.readFileSync(posesFile, 'utf8')) : {};
try{
  for(const k of cuts){
    const C = CUTS[k], frames = fs.mkdtempSync(path.join(os.tmpdir(), `film-${k}-`));
    const c = await tab(`${SITE}/index.html?film&v=${Date.now()}`, C.w, C.h);
    for(let i = 0; i < 600; i++){ await sleep(500); if(await c.ev('!!window.__film')) break; }
    const n = await c.ev('__film.frames'), fps = await c.ev('__film.fps');
    const start = await c.ev('__film.pose()');
    const t0 = Date.now();
    for(let i = 0; i < n; i++){
      await c.ev(`__film.shot(${i})`);
      const r = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 96, optimizeForSpeed: true });
      fs.writeFileSync(path.join(frames, `f${String(i).padStart(4, '0')}.jpg`), Buffer.from(r.data, 'base64'));
      if(i % 30 === 0) process.stdout.write(`\r${k} ${i}/${n}  ${((Date.now() - t0)/1000).toFixed(0)} s`);
    }
    const end = await c.ev('__film.pose()');
    c.close();
    poses[k] = { start, end };
    const [W, H] = C.out, scale = `scale=${W}:${H}:flags=lanczos`;
    /* tagged bt709 limited range, so every browser decodes the colours alike */
    const tag = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
    const yuv = ':out_color_matrix=bt709:out_range=tv,format=yuv420p';
    /* the film's own music (ElevenLabs) goes in with the pictures */
    const score = path.join(OUT, `score_${k}.m4a`);
    const sound = fs.existsSync(score);
    const audioIn = sound ? ['-i', score] : [], audio = sound ? ['-map', '0:v', '-map', '1:a', '-c:a', 'copy', '-shortest'] : ['-an'];
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', path.join(frames, 'f%04d.jpg'), ...audioIn,
      '-vf', scale + yuv, ...tag, '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '29', '-x264-params', 'aq-mode=3', '-profile:v', 'high', '-level', '4.2',
      '-movflags', '+faststart', ...audio, path.join(OUT, `${k}.mp4`)]);
    /* a lighter cut for slow connections, and a light first-frame still */
    const [lw, lh] = C.lite;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', path.join(frames, 'f%04d.jpg'), ...audioIn,
      '-vf', `scale=${lw}:${lh}:flags=lanczos` + yuv, ...tag, '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '30', '-x264-params', 'aq-mode=3', '-profile:v', 'high', '-level', '4.0',
      '-movflags', '+faststart', ...audio, path.join(OUT, `${k}_lite.mp4`)]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(frames, 'f0000.jpg'), '-vf', scale, '-q:v', '7', path.join(OUT, `${k}.jpg`)]);
    fs.rmSync(frames, { recursive: true, force: true });
    console.log(`\r${k}: ${n} frames in ${((Date.now() - t0)/1000).toFixed(0)} s, ${(fs.statSync(path.join(OUT, `${k}.mp4`)).size/1e6).toFixed(1)} MB`);
  }
  fs.writeFileSync(posesFile, JSON.stringify(poses, null, 1) + '\n');
}finally{
  const gone = new Promise(r => chrome.once('exit', r));
  chrome.kill();
  await gone;
  try{ fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }catch(_){}
}
