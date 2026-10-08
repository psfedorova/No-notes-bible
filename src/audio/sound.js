import { ASSETS } from '../core/config.js';

const MUTE_KEY = 'liber-arcanum.muted';
const sfx = (()=>{
  let ac = null, out = null, noise = null;
  let muted = false, ambStarted = false;
  try{ muted = localStorage.getItem(MUTE_KEY) === '1'; }catch(e){}
  function ready(){
    if(muted) return null;
    if(!ac){
      const AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return null;
      ac = new AC();
      out = ac.createGain(); out.gain.value = 0.8; out.connect(ac.destination);
      noise = ac.createBuffer(1, ac.sampleRate*2, ac.sampleRate);
      const d = noise.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i] = Math.random()*2 - 1;
    }
    if(ac.state === 'suspended') ac.resume();
    return ac;
  }
  function hiss(at, dur, f0, f1, q, gain, type){
    const src = ac.createBufferSource(); src.buffer = noise;
    src.playbackRate.value = 0.8 + Math.random()*0.4;
    const flt = ac.createBiquadFilter(); flt.type = type || 'bandpass'; flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, at); flt.frequency.exponentialRampToValueAtTime(f1, at + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.04, dur*0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(flt); flt.connect(g); g.connect(out);
    src.start(at, Math.random()*1.5, dur + 0.05);
  }
  const load = url => fetch(url).then(r=>r.arrayBuffer()).then(b=>ac.decodeAudioData(b));
  function twinkles(bufs){
    setTimeout(()=>twinkles(bufs), 7000 + Math.random()*13000);
    if(muted || !ac || ac.state !== 'running') return;
    const at = ac.currentTime + 0.05;
    const src = ac.createBufferSource(); src.buffer = bufs[Math.floor(Math.random()*bufs.length)];
    src.playbackRate.value = 0.9 + Math.random()*0.2;
    const g = ac.createGain(); g.gain.value = 0.16 + Math.random()*0.14;
    const pan = ac.createStereoPanner ? ac.createStereoPanner() : null;
    if(pan){ pan.pan.value = (Math.random()*2 - 1)*0.8; src.connect(pan); pan.connect(g); } else src.connect(g);
    g.connect(out); src.start(at);
  }
  function ambience(){
    if(ambStarted || !ready()) return;
    ambStarted = true;
    load(ASSETS.magicBed).then(buf=>{
      const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.42, ac.currentTime + 6);
      src.connect(g); g.connect(out); src.start();
    }).catch(()=>{});
    Promise.all(ASSETS.twinkles.map(load)).then(bufs=>setTimeout(()=>twinkles(bufs), 5000)).catch(()=>{});
    load(ASSETS.brook).then(buf=>{
      const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.4, ac.currentTime + 4);
      src.connect(g); g.connect(out); src.start();
    }).catch(()=>{});
  }
  function tone(at, freq, dur, gain, type){
    const o = ac.createOscillator(); o.type = type || 'sine'; o.frequency.setValueAtTime(freq, at);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(out);
    o.start(at); o.stop(at + dur + 0.05);
    return o;
  }
  return {
    get muted(){ return muted; },
    setMuted(m){
      muted = m;
      try{ localStorage.setItem(MUTE_KEY, m ? '1' : '0'); }catch(e){}
      if(out && ac){
        out.gain.cancelScheduledValues(ac.currentTime);
        out.gain.setTargetAtTime(m ? 0 : 0.8, ac.currentTime, m ? 0.25 : 0.6);
      }
      if(!m){ ready(); ambience(); }
    },
    ambience,
    wake(){ ready(); },
    page(){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t, 0.42, 2600, 700, 0.9, 0.22);
      hiss(t + 0.12, 0.5, 1800, 500, 0.7, 0.16);
      hiss(t + 0.05, 0.25, 5200, 2600, 1.4, 0.05);
    },
    settle(){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t, 0.16, 900, 300, 0.8, 0.12);
      tone(t, 120, 0.12, 0.05);
    },
    creak(opening){
      if(!ready()) return;
      const t = ac.currentTime;
      const o = tone(t, opening ? 66 : 58, 0.7, 0.03, 'sawtooth');
      o.frequency.linearRampToValueAtTime(opening ? 98 : 50, t + 0.65);
      hiss(t, 0.7, 1100, 380, 0.6, 0.1);
    },
    shimmer(){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t + 0.2, 1.6, 5200, 2400, 3, 0.025);
      [880, 1318.5, 1760, 2217].forEach((f, i)=>{
        const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f*(1 + (Math.random()-0.5)*0.004);
        const g = ac.createGain(), at = t + 0.3 + i*0.18;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.012, at + 0.5);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 2.2);
        o.connect(g); g.connect(out); o.start(at); o.stop(at + 2.3);
      });
    },
    thud(){
      if(!ready()) return;
      const t = ac.currentTime;
      tone(t, 64, 0.32, 0.26);
      tone(t, 128, 0.12, 0.06);
      hiss(t, 0.3, 650, 160, 0.7, 0.24);
      hiss(t + 0.03, 0.8, 2400, 900, 0.5, 0.03);
    },
    land(){
      if(!ready()) return;
      const t = ac.currentTime;
      tone(t, 70, 0.22, 0.08);
      hiss(t, 0.2, 600, 220, 0.7, 0.08);
    },
    burn(cap){
      if(!ready()) return;
      const t = ac.currentTime, len = cap ? 1.1 : 0.32;
      hiss(t, len + Math.random()*0.1, 7000 + Math.random()*1500, 4200, 0.9, cap ? 0.03 : 0.022, 'bandpass');
      hiss(t + 0.02, len*1.2, 700, 420, 0.7, cap ? 0.05 : 0.03, 'lowpass');
      const n = cap ? 7 : 1 + Math.floor(Math.random()*3);
      for(let i=0;i<n;i++) hiss(t + Math.random()*len, 0.008 + Math.random()*0.012, 2500 + Math.random()*3500, 1800, 1.4, 0.04 + Math.random()*0.06, 'highpass');
      if(Math.random() < (cap ? 1 : 0.16)) tone(t + 0.05, [2637, 3136, 3520, 3951][Math.floor(Math.random()*4)], cap ? 1.4 : 0.7, cap ? 0.006 : 0.0035);
    },
    vanish(many){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t, many ? 0.7 : 0.4, 1500, 5600, 1.1, many ? 0.04 : 0.026);
      if(Math.random() < (many ? 1 : 0.2)) tone(t + 0.08, [3520, 3136, 2637][Math.floor(Math.random()*3)], 0.8, many ? 0.008 : 0.004);
    },
    erase(){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t, 1.1, 1400, 6200, 1.2, 0.05);
      [1760, 1318.5, 987.8].forEach((f, i)=>tone(t + 0.12 + i*0.17, f, 0.9, 0.011));
    },
    flow(){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t, 0.6, 3000, 5400, 2, 0.022);
      [1318.5, 1760].forEach((f, i)=>tone(t + 0.1 + i*0.13, f, 0.8, 0.011));
    },
    flick(){
      if(!ready()) return;
      hiss(ac.currentTime, 0.16, 3000, 1100, 0.9, 0.08);
    },
    chime(){
      if(!ready()) return;
      const t = ac.currentTime;
      [1318.5, 1975.5, 2637].forEach((f, i)=>tone(t + i*0.07, f*(1 + (Math.random()-0.5)*0.01), 1.1, 0.018));
    }
  };
})();

export {
  sfx
};
