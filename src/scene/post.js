/* post-processing: bloom for the gilt and the magic, then a warm grade */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { HI_RES, VH, VW } from '../core/config.js';
import { camera, DPR, renderer, scene } from './renderer.js';
import { BeamPass } from './sunbeam.js';

/* post: bloom for the gilt and the magic, then a warm grade */
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(VW*DPR, VH*DPR, { type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(VW*DPR, VH*DPR) }));
/* the second target's clone shares the first's depth source, so the beam would read the
   depth the pass is drawing into; without MSAA in between, Safari draws nothing then */
composer.renderTarget2.depthTexture = new THREE.DepthTexture(VW*DPR, VH*DPR);
composer.setPixelRatio(DPR);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new BeamPass());
const bloom = new UnrealBloomPass(new THREE.Vector2(VW, VH), 0.34, 0.6, 0.9);
/* the glow is soft anyway: a phone blurs it from a sixteenth of the pixels */
if(!HI_RES){ const setSize = bloom.setSize.bind(bloom); bloom.setSize = (w, h)=>setSize(w/4, h/4); }
composer.addPass(bloom);
composer.addPass(new OutputPass());
const gradePass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.55 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uVig; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      /* one grade over the forest, the stone and the book alike: cool blue-green
         dusk in the shade, the sun's warmth kept only where it really falls */
      float l = dot(c, vec3(0.299,0.587,0.114));
      float yel = clamp((min(c.r, c.g) - c.b)*2.2, 0.0, 1.0)*(1.0 - 0.75*smoothstep(0.4, 0.75, l));
      c = mix(c, vec3(l), 0.32*yel + 0.06);
      vec3 shade = vec3(0.9, 0.98, 1.05), light = vec3(1.03, 1.0, 0.94);
      c *= mix(shade, light, smoothstep(0.25, 0.85, l));
      c += vec3(0.0, 0.006, 0.015)*(1.0 - smoothstep(0.0, 0.35, l));
      c = mix(c, smoothstep(0.0, 1.0, c), 0.25);
      float d = distance(vUv, vec2(0.5, 0.46));
      c *= mix(1.0, smoothstep(0.92, 0.28, d), uVig);
      gl_FragColor = vec4(c, 1.0);
    }`
});
composer.addPass(gradePass);

export {
  composer
};
