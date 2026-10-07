/* the book's shared materials: cover leather, gilt, leaf edges, lining */
import * as THREE from 'three';

const boardArt = side => new THREE.MeshPhysicalMaterial({
  color: 0x18233f, metalness: 0, roughness: 0.62, clearcoat: 0.1, clearcoatRoughness: 0.6,
  normalScale: new THREE.Vector2(1.0, 1.0), name: 'board-' + side
});
const matCoverFront = boardArt('front');
const matCoverBack  = boardArt('back');
/* the bright gap in the canopy behind the book would wash the matte leather out */
matCoverFront.envMapIntensity = matCoverBack.envMapIntensity = 0.55;
const matLeatherEdge = new THREE.MeshPhysicalMaterial({ color: 0x18233f, roughness: 0.65, metalness: 0, clearcoat: 0.15 });
const matGold = new THREE.MeshPhysicalMaterial({
  color: 0xc99b4a, metalness: 1, roughness: 0.33, envMapIntensity: 1.3, clearcoat: 0.12, clearcoatRoughness: 0.5,
  emissive: 0xffc56e, emissiveIntensity: 0
});
/* the fore edge of aged leaves, slightly uneven from leaf to leaf (vertex colours) */
const matLeafEdge = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.82, metalness:0.05, envMapIntensity:0.8 });
/* each leaf here is as thick as a few sheets of paper, so its cut face shows them: fine
   seams across it, each sheet a shade of its own. Where a pixel spans several sheets the
   seams melt into their mean tone instead of shimmering */
matLeafEdge.onBeforeCompile = sh=>{
  sh.vertexShader = 'attribute float aEdge; varying float vEdge;\n' + sh.vertexShader
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdge = aEdge;');
  sh.fragmentShader = 'varying float vEdge;\n' + sh.fragmentShader
    .replace('#include <color_fragment>', `#include <color_fragment>
      { float a = vEdge*5.0, w = fwidth(a), f = fract(a), d = min(f, 1.0 - f);
        float seam = 1.0 - smoothstep(0.0, 0.08 + 1.5*w, d);
        float tone = fract(sin(floor(a)*91.7 + vColor.r*613.0)*43758.5);
        float fade = 1.0 - smoothstep(0.25, 0.6, w);
        diffuseColor.rgb *= mix(0.94, 1.0 + 0.06*(tone - 0.5) - 0.2*seam, fade); }`);
};
/* a leaf deep in an open stack shows only the strip of it that runs out past the leaf
   above: that strip is the edge of the paper, each sheet a shade of its own, not the
   page painted on it stretched across the strip */
const matLeafStack = new THREE.MeshStandardMaterial({ color: 0xb39769, vertexColors: true, roughness: 0.85, metalness: 0, envMapIntensity: 0.8 });
matLeafStack.onBeforeCompile = sh=>{
  sh.vertexShader = 'attribute float aTint; varying float vTint;\n' + sh.vertexShader
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTint = aTint;');
  sh.fragmentShader = 'varying float vTint;\n' + sh.fragmentShader
    .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= vTint;');
};
const matLining = new THREE.MeshStandardMaterial({ color:0x3a2a18, roughness:1, metalness:0, side:THREE.DoubleSide });

export {
  matCoverBack, matCoverFront, matGold, matLeafEdge, matLeafStack, matLeatherEdge, matLining
};
