/* loading helpers: retries, the glTF loader, freeing what is uploaded */
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { HI_RES } from '../core/config.js';

/* a busy local server now and then drops a connection: try again before giving up */
const loadImage = (src, tries = 3) => new Promise((res, rej)=>{
  const i = new Image();
  i.onload = ()=>res(i);
  i.onerror = ()=>{
    if(tries > 1) setTimeout(()=>loadImage(src, tries - 1).then(res, rej), 400);
    else rej(new Error('Could not load ' + src + ' (open the book through the local server, not as a file)'));
  };
  i.src = src;
});
/* a picture that never changes once it is on the GPU: a phone lets go of its own copy
   (image, canvas or data) right after the upload. iOS counts every byte of a tab, and
   the forest, the boards and the rock held twice took Safari past its limit */
function shed(t){
  if(HI_RES || !t || t.userData.shed) return t;
  t.userData.shed = true;
  const after = t.onUpdate;
  t.onUpdate = ()=>{
    t.onUpdate = after;
    if(after) after(t);
    const im = t.source.data;
    if(im instanceof HTMLCanvasElement){ im.width = im.height = 0; }
    else if(im && im.close) im.close();
    t.source.data = null;
  };
  return t;
}
/* the same for any other load: run it again, a little later each time, before giving up */
async function retry(load, tries = 3){
  for(let k = 1; ; k++){
    try{ return await load(); }
    catch(e){
      if(k >= tries) throw e;
      await new Promise(r=>setTimeout(r, 300*k + Math.random()*200));
    }
  }
}
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/draco/gltf/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);
const firstMesh = gltf => { let m = null; gltf.scene.traverse(o=>{ if(!m && o.isMesh) m = o; }); return m; };

export {
  firstMesh, gltfLoader, loadImage, retry, shed
};
