import * as THREE from 'three';

const boardArt = side => new THREE.MeshPhysicalMaterial({
  color: 0x18233f, metalness: 0, roughness: 0.62, clearcoat: 0.1, clearcoatRoughness: 0.6,
  normalScale: new THREE.Vector2(1.0, 1.0), name: 'board-' + side
});
const matCoverFront = boardArt('front');
const matCoverBack  = boardArt('back');
matCoverFront.envMapIntensity = matCoverBack.envMapIntensity = 0.55;
const matLeatherEdge = new THREE.MeshPhysicalMaterial({ color: 0x18233f, roughness: 0.65, metalness: 0, clearcoat: 0.15 });
const matGold = new THREE.MeshPhysicalMaterial({
  color: 0xc99b4a, metalness: 1, roughness: 0.33, envMapIntensity: 1.3, clearcoat: 0.12, clearcoatRoughness: 0.5,
  emissive: 0xffc56e, emissiveIntensity: 0
});
const matLeafEdge = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.82, metalness:0.05, envMapIntensity:0.8 });
matLeafEdge.onBeforeCompile = sh=>{
  sh.vertexShader = 'attribute float aEdge; varying float vEdge;\n' + sh.vertexShader
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdge = aEdge;');
  sh.fragmentShader = '#undef USE_SHADOWMAP\nvarying float vEdge;\n' + sh.fragmentShader
    .replace('#include <color_fragment>', `#include <color_fragment>
      { float a = vEdge*5.0, w = fwidth(a), f = fract(a), d = min(f, 1.0 - f);
        float seam = 1.0 - smoothstep(0.0, 0.08 + 1.5*w, d);
        float tone = fract(sin(floor(a)*91.7 + vColor.r*613.0)*43758.5);
        float fade = 1.0 - smoothstep(0.25, 0.6, w);
        diffuseColor.rgb *= mix(0.94, 1.0 + 0.06*(tone - 0.5) - 0.2*seam, fade); }`)
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb*0.16;');
};
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
