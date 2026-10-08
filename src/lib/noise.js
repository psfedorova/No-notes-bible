import * as THREE from 'three';
import { mulberry32 } from './textures.js';

const NOISE_N = 128;
const noiseTex = (()=>{
  const N = NOISE_N, d = new Uint8Array(N*N*N), rnd = mulberry32(7331);
  for(let i=0;i<d.length;i++) d[i] = Math.floor(rnd()*256);
  const t = new THREE.Data3DTexture(d, N, N, N);
  t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
})();
const NOISE_GLSL = `
  uniform highp sampler3D tNoise;
  float vn3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0 - 2.0*f);
    return textureLod(tNoise, (i + f + 0.5)*${(1/NOISE_N).toFixed(8)}, 0.0).r; }
`;

export {
  NOISE_GLSL, noiseTex
};
