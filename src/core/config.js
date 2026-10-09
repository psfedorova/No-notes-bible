const PW = 3.40, PH = 4.70;
const N = 50;
const T = 0.56;
const LT = T/N;
const LH = LT*0.42;
const EPS = 0.004;
const CVR = 0.055;
const OV = 0.09, OVH = 0.09;
const CH = PH + OVH*2;
const XJ_C = 0.06, XJ_O = 0.27;
const CW = PW + OV - XJ_C;
const ZB = -(T/2 + EPS);
const RB = T/0.45;
const ALPHA = LT/RB;
const SWELL = 0.05;
const FAN = 0.07;
const M = 48, R = 10;
const OPEN = Math.PI;
const BACK_GAP = 0.022;

const HI_RES = !(matchMedia && matchMedia('(pointer: coarse)').matches);
const PAGE_W = HI_RES ? 1536 : 1024, PAGE_H = Math.round(PAGE_W*1416/1024);
const SC = PAGE_W/340;
const FS = PAGE_W/880;
const INK = '#2e1c0e';
const LS_KEY = 'liber-arcanum.v2';

const ROCK_TOP = 0;
const LIFT_H = 3.0;
const GROUND_Y = -3.4;

const FONTS = [
  { id:'chronicle', name:'Chronicle', css:'"Cormorant Garamond"', capCss:'"Cormorant Garamond"',
    weight:500, style:'italic', size:44, lead:1.315, capWeight:600 }
];
const fontById = id => FONTS.find(f=>f.id===id) || FONTS[0];
const capFont = (f, size) => `${f.capWeight || 400} ${Math.round(size)}px ${f.capCss || f.css}, ${f.css}, serif`;
const fontCss = (f, size, weight) => `${f.style==='italic'?'italic ':''}${weight||f.weight} ${Math.round(size)}px ${f.css}, "Cormorant Garamond", serif`;

const ASSETS = {
  forest: 'assets/forest/forest_4k.jpg?v=5', forestDepth: 'assets/forest/depth_4k.png?v=5',
  forestFull: HI_RES ? 'assets/forest/forest.jpg?v=5' : null, depthFull: HI_RES ? 'assets/forest/depth.png?v=5' : null,
  forestWater: 'assets/forest/water.png', forestLight: 'assets/forest/light_1k.hdr',
  forestBack: 'assets/forest/back.jpg?v=5', forestBackDepth: 'assets/forest/back_depth.png?v=5', forestNear: 'assets/forest/near.json?v=5',
  brook: 'assets/audio/forest_brook.wav', magicBed: 'assets/audio/magic_forest.wav',
  twinkles: ['assets/audio/twinkle_a.mp3', 'assets/audio/twinkle_b.mp3', 'assets/audio/twinkle_c.mp3'],
  leaAlbedo: 'assets/leather/brown_leather_albedo_1k.jpg', leaNor: 'assets/leather/brown_leather_nor_gl_1k.jpg',
  leaRough: 'assets/leather/brown_leather_rough_1k.jpg',
  goldFront: 'assets/models/gold_front.glb?v=2', goldBack: 'assets/models/gold_back.glb?v=2',
  maskFront: 'assets/models/gold_front_mask.png?v=2', maskBack: 'assets/models/gold_back_mask.png?v=2',
  rock: 'assets/models/rock.glb?v=3',
  granite: 'assets/rock/granite.jpg', moss: 'assets/rock/moss.jpg',
  stone: HI_RES ? 'assets/rock/stone_2k.jpg' : 'assets/rock/stone_1k.jpg', stoneNor: 'assets/rock/stone_nor.jpg'
};

let VW = 1280, VH = 720;
function measureViewport(){
  const w = innerWidth || document.documentElement.clientWidth || 0;
  const h = innerHeight || document.documentElement.clientHeight || 0;
  if(w >= 2 && h >= 2){ VW = w; VH = h; return true; }
  return false;
}
measureViewport();

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const ALT = IS_MAC ? '⌥' : 'Alt+';

export {
  ALPHA, ALT, ASSETS, BACK_GAP, capFont, CH, CVR, CW, EPS, FAN, fontById, fontCss, FONTS, FS,
  GROUND_Y, HI_RES, INK, LH, LIFT_H, LS_KEY, LT, M, measureViewport, MOD, N, OPEN,
  PAGE_H, PAGE_W, PH, PW, R, RB, ROCK_TOP, SC, SWELL, T, VH, VW, XJ_C, XJ_O, ZB
};
