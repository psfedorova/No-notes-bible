import * as THREE from 'three';
import { lerp, smooth } from '../lib/textures.js';
import { GROUND_Y } from '../core/config.js';
import { scene, SUN_DIR } from './renderer.js';
import { clock } from '../app/loop.js';

const leafTex = new THREE.TextureLoader().load('assets/leaves/fall_leaves.png');
leafTex.colorSpace = THREE.SRGBColorSpace; leafTex.anisotropy = 4;
const leafSun = { value: SUN_DIR }, leafHaze = { value: null };
const leafMats = [0xd6dcc4, 0xe8dc9a, 0xd8b06c, 0xa88660].map(tint=>{
  const m = new THREE.MeshStandardMaterial({ map: leafTex, color: tint, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85, metalness: 0, envMapIntensity: 0.55 });
  m.onBeforeCompile = sh=>{
    sh.uniforms.uSunW = leafSun; sh.uniforms.tHaze = leafHaze;
    sh.vertexShader = 'varying vec4 vScr;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvScr = gl_Position;');
    sh.fragmentShader = 'uniform vec3 uSunW; uniform sampler2D tHaze; varying vec4 vScr;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', `
      { vec3 sv = normalize((viewMatrix*vec4(uSunW, 0.0)).xyz);
        float back = pow(clamp(-dot(normalize(vViewPosition), sv), 0.0, 1.0), 2.0);
        outgoingLight += diffuseColor.rgb*vec3(1.0, 0.95, 0.62)*(0.3 + 2.4*back);
        vec3 haze = textureLod(tHaze, vScr.xy/vScr.w*0.5 + 0.5, 4.0).rgb;
        outgoingLight = mix(outgoingLight, haze, clamp(1.0 - exp(-max(length(vViewPosition) - 20.0, 0.0)*0.015), 0.0, 0.35)); }
      #include <opaque_fragment>`);
  };
  return m;
});
const leafGeos = Array.from({length: 8}, (_, c)=>{
  const g = new THREE.PlaneGeometry(0.42, 0.84, 2, 6);
  const p = g.attributes.position, uv = g.attributes.uv;
  const bend = 0.06 + Math.random()*0.1, cup = 0.03 + Math.random()*0.05;
  for(let i=0;i<p.count;i++){
    const x = p.getX(i)/0.21, y = p.getY(i)/0.42;
    p.setZ(i, bend*y*y + cup*x*x);
    uv.setXY(i, (c % 4 + uv.getX(i))/4, 1 - ((c >> 2) + 1 - uv.getY(i))/2);
  }
  g.computeVertexNormals();
  return g;
});
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const AX_Y = new THREE.Vector3(0, 1, 0), AX_Z = new THREE.Vector3(0, 0, 1);
const LEAF_FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI/2);
const fallers = Array.from({length: 14}, (_, i)=>{
  const m = new THREE.Mesh(leafGeos[i % 8], leafMats[(i*3 + (i >> 2)) % 4]);
  m.userData = {};
  m.frustumCulled = false;
  scene.add(m);
  return m;
});
const KEEP_BOOK = 4.4;
const KEEP_PAD = 0.55;
const KEEP_NA = 48, KEEP_NY = 24, KEEP_Y0 = GROUND_Y - 0.5, KEEP_DY = 0.25;
let keepRock = null;
function keepAt(x, y, z){
  let r = KEEP_BOOK;
  if(keepRock){
    const fj = (y - KEEP_Y0)/KEEP_DY - 0.5, fa = (Math.atan2(z, x)/(2*Math.PI) + 1)*KEEP_NA - 0.5;
    const j0 = Math.floor(fj), a0 = Math.floor(fa), tj = fj - j0, ta = fa - a0;
    const at = (j, a)=>j < 0 || j >= KEEP_NY ? 0 : keepRock[j*KEEP_NA + (a % KEEP_NA)];
    r = Math.max(r, lerp(lerp(at(j0, a0), at(j0, a0 + 1), ta), lerp(at(j0 + 1, a0), at(j0 + 1, a0 + 1), ta), tj));
  }
  return r + KEEP_PAD;
}
function measureRock(mesh){
  mesh.updateWorldMatrix(true, false);
  const p = mesh.geometry.attributes.position, v = new THREE.Vector3(), raw = new Float32Array(KEEP_NA*KEEP_NY);
  for(let i=0;i<p.count;i++){
    v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
    const j = Math.floor((v.y - KEEP_Y0)/KEEP_DY);
    if(j < 0 || j >= KEEP_NY) continue;
    const k = j*KEEP_NA + Math.floor((Math.atan2(v.z, v.x)/(2*Math.PI) + 1)*KEEP_NA) % KEEP_NA;
    raw[k] = Math.max(raw[k], Math.hypot(v.x, v.z));
  }
  keepRock = new Float32Array(raw.length);
  for(let j=0;j<KEEP_NY;j++) for(let a=0;a<KEEP_NA;a++){
    let r = 0;
    for(let jj=Math.max(0, j - 1);jj<=Math.min(KEEP_NY - 1, j + 1);jj++)
      for(let da=-1;da<=1;da++) r = Math.max(r, raw[jj*KEEP_NA + (a + da + KEEP_NA) % KEEP_NA]);
    keepRock[j*KEEP_NA + a] = r;
  }
  fallers.forEach(m=>{ const u = m.userData; if(Math.hypot(u.x, u.z) < keepAt(u.x, u.y, u.z) + u.A) spawnLeaf(m, true); });
}
function spawnLeaf(m, anywhere){
  const u = m.userData;
  u.tumble = Math.random() < 0.25;
  u.A = 0.8 + Math.random()*1.2;
  let x, y, z;
  do{
    x = -18 + Math.random()*36; z = -20 + Math.random()*23;
    y = anywhere ? GROUND_Y + 2 + Math.random()*26 : 24 + Math.random()*8;
  }while(Math.hypot(x, z) < keepAt(x, y, z) + u.A || (Math.abs(x) < 5 && z > -3.5));
  u.x = x; u.y = y; u.z = z;
  u.v0 = (u.tumble ? 4.2 : 2.6) + Math.random()*1.6;
  u.w = 2.0 + Math.random()*1.3; u.ph = Math.random()*6.3;
  u.tilt = 0.45 + Math.random()*0.4;
  u.dir = Math.random()*6.3; u.dirW = (Math.random() - 0.5)*0.5;
  u.spin = Math.random()*6.3; u.spinW = (Math.random() - 0.5)*0.6;
  u.roll = Math.random()*6.3; u.rollW = (Math.random() < 0.5 ? -1 : 1)*(4 + Math.random()*3);
  m.scale.setScalar(0.75 + Math.random()*0.5);
}
fallers.forEach(m=>spawnLeaf(m, true));

const FLIES = 44;
const fireflyMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uScale: { value: 1 } },
  vertexShader: `attribute float alpha, tint; varying float vA, vT; uniform float uScale;
    void main(){ vA = alpha; vT = tint; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = uScale*(0.7 + 0.9*min(alpha, 1.0))/max(0.1, -mv.z); }`,
  fragmentShader: `varying float vA, vT;
    void main(){ vec2 c = gl_PointCoord - 0.5; float r2 = dot(c, c);
      float core = exp(-r2*220.0), glow = exp(-r2*20.0);
      vec3 col = mix(vec3(0.72, 1.0, 0.34), vec3(1.0, 0.85, 0.45), vT);
      gl_FragColor = vec4((col*glow*1.1 + vec3(1.0, 1.0, 0.8)*core*2.6)*vA, 1.0); }`
});
const flyGeo = new THREE.BufferGeometry();
const flyPos = new Float32Array(FLIES*3), flyAlpha = new Float32Array(FLIES), flyTint = new Float32Array(FLIES);
const flySeed = Array.from({length: FLIES}, ()=>{
  let x, z; do{ x = -20 + Math.random()*40; z = -22 + Math.random()*26; }while(Math.hypot(x, z) < 4 || (Math.abs(x) < 4 && z > 1));
  const r = ()=>Math.random();
  return { x, z, y: GROUND_Y + 0.8 + Math.pow(r(), 1.8)*11,
    a: [0.05 + r()*0.12, 0.11 + r()*0.2, 0.07 + r()*0.14], p: [r()*40, r()*40, r()*40], R: 1.5 + r()*2.5,
    T: 3.5 + r()*5, off: r()*10, twice: r() < 0.3, b: 0.55 + r()*0.45, tint: Math.pow(r(), 2.5) };
});
flySeed.forEach((q, i)=>{ flyTint[i] = q.tint; });
flyGeo.setAttribute('position', new THREE.BufferAttribute(flyPos, 3));
flyGeo.setAttribute('alpha', new THREE.BufferAttribute(flyAlpha, 1));
flyGeo.setAttribute('tint', new THREE.BufferAttribute(flyTint, 1));
const flies = new THREE.Points(flyGeo, fireflyMat);
flies.frustumCulled = false;
scene.add(flies);
function pulse(t){ return t < 0 ? 0 : (t < 0.2 ? smooth(t/0.2) : Math.exp(-(t - 0.2)*4.2)); }

function stepLife(dt){
  const wx = 0.35 + 0.3*Math.sin(clock*0.11), wz = 0.12*Math.sin(clock*0.07 + 1.3);
  for(const m of fallers){
    const u = m.userData;
    u.ph += u.w*dt; u.dir += u.dirW*dt; u.spin += u.spinW*dt;
    const s = Math.sin(u.ph), c = Math.cos(u.ph), dx = Math.cos(u.dir), dz = Math.sin(u.dir);
    let vx = wx + (u.tumble ? dx*0.9 : 0), vz = wz + (u.tumble ? dz*0.9 : 0);
    const a = keepAt(u.x, u.y, u.z) + (u.tumble ? 0 : u.A), r2 = u.x*u.x + u.z*u.z;
    if(r2 > a*a){
      const k = a*a/(r2*r2), A = u.x*u.x - u.z*u.z, B = 2*u.x*u.z;
      const gx = vx*A + vz*B, gz = vx*B - vz*A;
      vx -= k*gx; vz -= k*gz;
    }
    u.x += vx*dt; u.z += vz*dt;
    _qa.setFromAxisAngle(AX_Y, -u.dir);
    if(u.tumble){
      u.y -= u.v0*dt;
      u.roll += u.rollW*dt;
      m.position.set(u.x, u.y, u.z);
      _qb.setFromAxisAngle(AX_Z, u.roll);
      m.quaternion.copy(_qa).multiply(_qb).multiply(LEAF_FLAT);
    }else{
      u.y -= u.v0*(0.25 + 0.75*c*c)*dt;
      const lat = u.A*s;
      m.position.set(u.x + dx*lat, u.y + 0.18*u.A*s*s, u.z + dz*lat);
      _qb.setFromAxisAngle(AX_Z, -u.tilt*c);
      _qc.setFromAxisAngle(AX_Y, u.spin);
      m.quaternion.copy(_qa).multiply(_qb).multiply(_qc).multiply(LEAF_FLAT);
    }
    const px = m.position.x, pz = m.position.z, pr = Math.hypot(px, pz), K = keepAt(px, m.position.y, pz);
    if(pr < K){
      const e = (K - pr)/Math.max(pr, 1e-3);
      u.x += px*e; u.z += pz*e;
      m.position.x += px*e; m.position.z += pz*e;
    }
    if(u.y < GROUND_Y + 0.3) spawnLeaf(m, false);
  }
  for(let i=0;i<FLIES;i++){
    const q = flySeed[i], t = clock;
    const k = ((t + q.off) % q.T + q.T) % q.T;
    const f = Math.min(1, pulse(k) + (q.twice ? 0.8*pulse(k - 0.7) : 0));
    flyPos[i*3]   = q.x + Math.sin(t*q.a[0] + q.p[0])*q.R + Math.sin(t*q.a[1]*1.7 + q.p[1])*q.R*0.35;
    flyPos[i*3+1] = q.y + Math.sin(t*q.a[1] + q.p[2])*0.9 + f*0.35;
    flyPos[i*3+2] = q.z + Math.sin(t*q.a[2] + q.p[1])*q.R + Math.cos(t*q.a[0]*1.3 + q.p[2])*q.R*0.35;
    flyAlpha[i] = 0.03 + f*q.b;
  }
  flyGeo.attributes.position.needsUpdate = true;
  flyGeo.attributes.alpha.needsUpdate = true;
}

export {
  fallers, fireflyMat, leafHaze, measureRock, stepLife
};
