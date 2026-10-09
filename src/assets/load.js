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
import { fetchNear, nearField } from '../scene/plants.js';

const imgs = {};
async function loadAssets(fontsReady = Promise.resolve()){
  const near = fetchNear();
  const img = {};
  ['leaAlbedo','leaNor','leaRough','maskFront','maskBack','forest','forestWater','granite','moss','stone','stoneNor']
    .forEach(k=>{ img[k] = loadImage(ASSETS[k]).then(i=>{ imgs[k] = i; }); });
  const leather = Promise.all(['leaAlbedo','leaNor','leaRough','maskFront','maskBack'].map(k=>img[k]))
    .then(()=>fontsReady).then(()=>applyLeather(imgs));
  leather.catch(()=>{});
  const imgJobs = Object.values(img);
  const model = url => retry(()=>gltfLoader.loadAsync(url));
  const models = Promise.all([model(ASSETS.goldFront), model(ASSETS.goldBack), model(ASSETS.rock)]);
  const depth = retry(()=>decodeDepth(ASSETS.forestDepth));
  const light = retry(()=>new RGBELoader().loadAsync(ASSETS.forestLight));
  await Promise.all(imgJobs);
  const [gf, gb, rk] = await models;
  const hdr = await light;
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromEquirectangular(hdr).texture;
  pm.dispose(); hdr.dispose();
  scene.environmentIntensity = 1.15;
  scene.environmentRotation.set(0, FOREST_YAW, 0);
  scene.background = null;
  await leather;
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
  rockGrp.traverse(o=>{ if(o.isMesh) o.renderOrder = -6; });
  spinGrp.traverse(o=>{ if(o.isMesh && !o.renderOrder) o.renderOrder = -8; });
  await nearField(rockMaterial(imgs, true), near);
}
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
