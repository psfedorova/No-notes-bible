/* the book's measurements, the device tier, the fonts and the asset paths */
/* ============================== dimensions ==============================
   1 unit is about a decimetre.                                            */
const PW = 3.40, PH = 4.70;        // leaf width (spine to fore edge) and height
const N = 50;                      // leaves -> 100 pages
const T = 0.56;                    // text block thickness
const LT = T/N;                    // leaf pitch
const LH = LT*0.42;                // half thickness of one leaf slab
const EPS = 0.004;                 // air between the block and a board
const CVR = 0.055;                 // board thickness
const OV = 0.09, OVH = 0.09;       // board overhang at fore edge, head and tail
const CH = PH + OVH*2;
const XJ_C = 0.06, XJ_O = 0.27;    // board spine edge: closed / open
const CW = PW + OV - XJ_C;         // board width (matches blender/build_assets.py)
const ZB = -(T/2 + EPS);           // inner face of the back board
const RB = T/0.45;                 // radius of the spine back when open
const ALPHA = LT/RB;               // arc taken by one leaf on that back
const SWELL = 0.05;                // rounding of the closed spine
const FAN = 0.07;                  // fore-corner lift of the top resting leaf
const M = 48, R = 10;              // leaf grid: along the arc, along the height
const OPEN = Math.PI;
const BACK_GAP = 0.022;            // spine leather to the sewn backs

/* sharper pages where there is memory to spare; phones keep the lighter sheet */
const HI_RES = !(matchMedia && matchMedia('(pointer: coarse)').matches);
const PAGE_W = HI_RES ? 1536 : 1024, PAGE_H = Math.round(PAGE_W*1416/1024);
const SC = PAGE_W/340;             // page artwork is drawn in a 340 x 470 space
const FS = PAGE_W/880;             // font sizes below were tuned on an 880 px page
const INK = '#2e1c0e';
const LS_KEY = 'liber-arcanum.v2';

const ROCK_TOP = 0;                // the boulder's resting dome peaks here
const LIFT_H = 3.0;                // how high the book floats while it is turned
const GROUND_Y = -3.4;             // the forest floor the boulder is sunk in

/* one hand for the whole book, the title page's own: Cormorant Garamond italic,
   the face of its motto. It cuts Latin and Cyrillic as one design, so Russian
   and English share every metric and burn in exactly alike. Initials are the
   upright capitals of the same face. lead keeps the old line pitch, so pages
   written before keep their line count */
const FONTS = [
  { id:'chronicle', name:'Chronicle', css:'"Cormorant Garamond"', capCss:'"Cormorant Garamond"',
    weight:500, style:'italic', size:44, lead:1.315, capWeight:600 }
];
const fontById = id => FONTS.find(f=>f.id===id) || FONTS[0];
const capFont = (f, size) => `${f.capWeight || 400} ${Math.round(size)}px ${f.capCss || f.css}, ${f.css}, serif`;
const fontCss = (f, size, weight) => `${f.style==='italic'?'italic ':''}${weight||f.weight} ${Math.round(size)}px ${f.css}, "Cormorant Garamond", serif`;

/* a phone gets the 4k forest with its depth at the same size (6144 is past the texture
   limit of many phones), the light and the leather at 1k: the leather is dyed down to
   1024 anyway, and the light only feeds the blurred reflections */
const LEA = HI_RES ? '2k' : '1k';
const ASSETS = {
  forest: HI_RES ? 'assets/forest/forest.jpg' : 'assets/forest/forest_4k.jpg',
  forestDepth: HI_RES ? 'assets/forest/depth.png' : 'assets/forest/depth_4k.png', forestWater: 'assets/forest/water.png',
  forestLight: HI_RES ? 'assets/forest/light.hdr' : 'assets/forest/light_1k.hdr',
  forestBack: 'assets/forest/back.jpg', forestBackDepth: 'assets/forest/back_depth.png', forestNear: 'assets/forest/near.json',
  brook: 'assets/audio/forest_brook.wav', magicBed: 'assets/audio/magic_forest.wav',
  twinkles: ['assets/audio/twinkle_a.mp3', 'assets/audio/twinkle_b.mp3', 'assets/audio/twinkle_c.mp3'],
  leaAlbedo: `assets/leather/brown_leather_albedo_${LEA}.jpg`, leaNor: `assets/leather/brown_leather_nor_gl_${LEA}.jpg`,
  leaRough: `assets/leather/brown_leather_rough_${LEA}.jpg`,
  goldFront: 'assets/models/gold_front.glb?v=2', goldBack: 'assets/models/gold_back.glb?v=2',
  maskFront: 'assets/models/gold_front_mask.png?v=2', maskBack: 'assets/models/gold_back_mask.png?v=2',
  rock: 'assets/models/rock.glb?v=3',
  granite: 'assets/rock/granite.jpg', moss: 'assets/rock/moss.jpg',
  stone: HI_RES ? 'assets/rock/stone_2k.jpg' : 'assets/rock/stone_1k.jpg', stoneNor: 'assets/rock/stone_nor.jpg'
};

/* A backgrounded pane can report a 0x0 viewport; keep the last good size. */
let VW = 1280, VH = 720;
function measureViewport(){
  const w = innerWidth || document.documentElement.clientWidth || 0;
  const h = innerHeight || document.documentElement.clientHeight || 0;
  if(w >= 2 && h >= 2){ VW = w; VH = h; return true; }
  return false;
}
measureViewport();

/* the modifier key as the shortcuts card and the tooltips name it */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl+';

export {
  ALPHA, ASSETS, BACK_GAP, capFont, CH, CVR, CW, EPS, FAN, fontById, fontCss, FONTS, FS,
  GROUND_Y, HI_RES, INK, LH, LIFT_H, LS_KEY, LT, M, measureViewport, MOD, N, OPEN,
  PAGE_H, PAGE_W, PH, PW, R, RB, ROCK_TOP, SC, SWELL, T, VH, VW, XJ_C, XJ_O, ZB
};
