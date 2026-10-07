/* post-processing: bloom for the gilt and the magic, then a warm grade */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { HI_RES, VH, VW } from '../core/config.js';
import { camera, DPR, renderer, scene } from './renderer.js';
import { BEAM_MIX, BeamPass } from './sunbeam.js';
import { SOFT_MIX, SoftPass } from './soft.js';

/* post: bloom for the gilt and the magic, the shaft of sun, then a warm grade. Only the
   scene is drawn at full size, with MSAA; the shaft and the glow are worked out on small
   pictures of their own, and the last pass lays both over the scene as it tone maps and
   grades it, so no pass but that one touches every pixel again */
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(VW*DPR, VH*DPR, { type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(VW*DPR, VH*DPR) }));
/* the second target's clone shares the first's depth source; it is never drawn into now
   (no pass swaps), but keeps a depth of its own so that it never could share one */
composer.renderTarget2.samples = 0;
composer.renderTarget2.depthTexture = new THREE.DepthTexture(VW*DPR, VH*DPR);
composer.setPixelRatio(DPR);
composer.addPass(new RenderPass(scene, camera));
const beamPass = new BeamPass();
composer.addPass(beamPass);
const softPass = new SoftPass();
composer.addPass(softPass);
/* the glow without its last step: the blurred mips are added in the final pass instead
   of being blended over the whole frame here */
class GlowPass extends UnrealBloomPass {
  render(renderer, writeBuffer, readBuffer){
    renderer.getClearColor(this._oldClearColor);
    this.oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);
    this.highPassUniforms.tDiffuse.value = readBuffer.texture;
    this.highPassUniforms.luminosityThreshold.value = this.threshold;
    this.fsQuad.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    this.fsQuad.render(renderer);
    let input = this.renderTargetBright;
    for(let i=0;i<this.nMips;i++){
      const m = this.separableBlurMaterials[i];
      this.fsQuad.material = m;
      m.uniforms.colorTexture.value = input.texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      this.fsQuad.render(renderer);
      m.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      this.fsQuad.render(renderer);
      input = this.renderTargetsVertical[i];
    }
    this.fsQuad.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.bloomStrength.value = this.strength;
    this.compositeMaterial.uniforms.bloomRadius.value = this.radius;
    this.compositeMaterial.uniforms.bloomTintColors.value = this.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    renderer.clear();
    this.fsQuad.render(renderer);
    renderer.setClearColor(this._oldClearColor, this.oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }
}
const bloom = new GlowPass(new THREE.Vector2(VW, VH), 0.34, 0.6, 0.9);
/* the glow is soft anyway: a phone blurs it from a sixteenth of the pixels */
if(!HI_RES){ const setSize = bloom.setSize.bind(bloom); bloom.setSize = (w, h)=>setSize(w/4, h/4); }
composer.addPass(bloom);
/* the shaft and the glow added to the scene, tone mapped (three adds the ACES curve and
   the sRGB transfer for a pass drawn to the screen) and graded */
class FinalPass extends Pass {
  constructor(){
    super();
    this.needsSwap = false;
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, tBloom: { value: null }, uVig: { value: 0.55 }, ...beamPass.uniforms, ...softPass.uniforms },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse, tDepth, tBloom, tLow, tSoft; uniform mat4 uInvProj; uniform vec3 uCol; uniform float uK, uVig, uSoftOn; varying vec2 vUv;
        ${BEAM_MIX}
        ${SOFT_MIX}
        void main(){
          vec4 soft = softAt();
          vec3 c = (texture2D(tDiffuse, vUv).rgb + beamAt())*(1.0 - soft.a) + soft.rgb + texture2D(tBloom, vUv).rgb;
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          c = gl_FragColor.rgb;
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
    this.quad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer){
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture; u.tDepth.value = readBuffer.depthTexture;
    u.tBloom.value = bloom.enabled ? bloom.renderTargetsHorizontal[0].texture : null;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}
composer.addPass(new FinalPass());

export {
  composer
};
