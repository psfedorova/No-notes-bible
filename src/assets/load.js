/* loads every scan and model the book needs and builds what depends on them */
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { ASSETS, HI_RES, ROCK_TOP } from '../core/config.js';
import { FOREST_YAW, renderer, scene } from '../scene/renderer.js';
import { spinGrp } from '../scene/rig.js';
import { matGold } from '../book/materials.js';
import { backGoldSlot, frontGoldSlot } from '../book/boards.js';
import { leafHaze, measureRock } from '../scene/forest-life.js';
import { firstMesh, gltfLoader, loadImage, retry } from './loaders.js';
import { applyLeather } from '../book/leather.js';
import { mossShells, rockMaterial, trimBuried } from '../scene/rock.js';
import { backdrop, decodeDepth, makeBackdrop, measureFoot } from '../scene/forest.js';
import { nearField } from '../scene/plants.js';

/* loading comes in two parts. All that is in view (the book, the boulder, the plants and
   grass round it, the forest at 4k and its light) is fetched first and shows at once,
   after a fraction of the bytes; then, once the book is in the reader's hands, loadMore
   brings the layer behind the trunks and on a computer the 6k forest, crossfaded in,
   only while nothing is being moved */
const imgs = {};
async function loadAssets(){
  const imgJobs = ['forest','forestWater','granite','moss','stone','stoneNor','leaAlbedo','leaNor','leaRough','maskFront','maskBack']
    .map(k=>loadImage(ASSETS[k]).then(i=>{ imgs[k] = i; }));
  const model = url => retry(()=>gltfLoader.loadAsync(url));
  const models = Promise.all([model(ASSETS.goldFront), model(ASSETS.goldBack), model(ASSETS.rock)]);
  const depth = retry(()=>decodeDepth(ASSETS.forestDepth));
  const light = retry(()=>new RGBELoader().loadAsync(ASSETS.forestLight));
  await Promise.all(imgJobs);
  const [gf, gb, rk] = await models;
  /* the boulder and the book are lit by the forest they stand in, the same render */
  const hdr = await light;
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromEquirectangular(hdr).texture;
  pm.dispose(); hdr.dispose();
  scene.environmentIntensity = 1.15;
  scene.environmentRotation.set(0, FOREST_YAW, 0);
  scene.background = null;
  applyLeather(imgs);
  scene.add(makeBackdrop(imgs.forest, await depth, imgs.forestWater, null, null));
  backdrop.setDetail(imgs.moss);
  leafHaze.value = backdrop.picture;
  [[gf, frontGoldSlot], [gb, backGoldSlot]].forEach(([gl, slot])=>{
    const m = firstMesh(gl);
    m.material = matGold;
    m.castShadow = false; m.receiveShadow = true;
    m.userData.noPick = true;
    m.position.set(0,0,0); m.rotation.set(0,0,0); m.scale.set(1,1,1);
    slot.add(m);
  });
  const rock = firstMesh(rk);
  rock.material = rockMaterial(imgs);
  rock.receiveShadow = true; rock.castShadow = true;
  const rockGrp = new THREE.Group();
  rockGrp.rotation.x = -Math.PI/2;
  rockGrp.position.y = ROCK_TOP;
  rock.position.set(0,0,0); rock.rotation.set(0,0,0);
  rockGrp.add(rock);
  trimBuried(rock);
  rockGrp.add(mossShells(rock, rock.material.userData.u, HI_RES ? 9 : 4));
  const rockYaw = new THREE.Group();
  rockYaw.rotation.y = FOREST_YAW;
  rockYaw.add(rockGrp);
  scene.add(rockYaw);
  measureRock(rock);
  measureFoot(rock, rockGrp);
  /* drawn before the floor that hides what is buried: that floor is coarser than the
     render's ground and would otherwise shave the stone's foot off, baring the black
     earth beneath it */
  rockGrp.traverse(o=>{ if(o.isMesh) o.renderOrder = -6; });
  /* and the book before both: it covers much of the stone and its moss, whose costly
     shading (nine shells of strands) is then never worked out under it */
  spinGrp.traverse(o=>{ if(o.isMesh && !o.renderOrder) o.renderOrder = -8; });
  /* what grows round the boulder comes with it (compressed it is a few MB), so all that
     is in view shows at once; nothing grows in after the book is shown */
  await nearField(rockMaterial(imgs, true));
  /* the boulder's shadow is in the forest render itself; the backdrop only fills the
     floor under its foot (uFoot) */
}
/* the rest, after the book is shown. calm() waits for a moment when nothing is being
   turned, thrown or riffled, so a texture going up to the GPU never lands mid-gesture */
async function loadMore(calm = ()=>Promise.resolve()){
  try{
    const [back, backDepth] = await Promise.all([loadImage(ASSETS.forestBack), retry(()=>decodeDepth(ASSETS.forestBackDepth, true))]);
    await back.decode().catch(()=>{});
    await calm();
    backdrop.setBack(back, backDepth);
  }catch(e){ console.warn('The forest behind the trunks could not be loaded:', e); }
  if(ASSETS.forestFull){
    try{
      const [pano, depth] = await Promise.all([loadImage(ASSETS.forestFull), retry(()=>decodeDepth(ASSETS.depthFull))]);
      await pano.decode().catch(()=>{});
      await calm();
      renderer.initTexture(depth);
      renderer.initTexture(backdrop.setPano(pano, depth));
    }catch(e){ console.warn('The sharper forest could not be loaded:', e); }
  }
}

export {
  loadAssets, loadMore
};
