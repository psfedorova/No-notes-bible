/* Packs the PNG data maps the page loads into lossless WebP, pixel for pixel the same and
   about a quarter smaller. The PNGs stay as the sources the blender scripts write.

     node tools/webp.mjs     (after any edit to these PNGs, then bump their ?v in src/core/config.js)

   Needs cwebp (brew install webp). The gold masks stay PNG: Safari decodes a grey WebP
   to other values than the grey PNG. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['assets/forest/depth_4k', 'assets/forest/depth', 'assets/forest/back_depth', 'assets/forest/water', 'assets/leaves/fall_leaves'];
for(const f of FILES){
  execFileSync('cwebp', ['-quiet', '-lossless', '-z', '9', '-exact', '-metadata', 'none', path.join(ROOT, f + '.png'), '-o', path.join(ROOT, f + '.webp')]);
  console.log('wrote', f + '.webp');
}
