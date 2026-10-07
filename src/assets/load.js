/* loads every scan and model the book needs and builds what depends on them */
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { ASSETS, HI_RES, ROCK_TOP } from '../core/config.js';
import { FOREST_YAW, renderer, scene } from '../scene/renderer.js';
import { matGold } from '../book/materials.js';
import { backGoldSlot, frontGoldSlot } from '../book/boards.js';
import { leafHaze, measureRock } from '../scene/forest-life.js';
import { firstMesh, gltfLoader, loadImage, retry } from './loaders.js';
import { applyLeather } from '../book/leather.js';
import { mossShells, rockMaterial } from '../scene/rock.js';
import { backdrop, decodeDepth, makeBackdrop, measureFoot } from '../scene/forest.js';
import { nearField } from '../scene/plants.js';

async function loadAssets(){
  const imgs = {};
  const imgJobs = ['forest','forestWater','forestBack','granite','moss','stone','stoneNor','leaAlbedo','leaNor','leaRough','maskFront','maskBack']
    .map(k=>loadImage(ASSETS[k]).then(i=>{ imgs[k] = i; }));
  const model = url => retry(()=>gltfLoader.loadAsync(url));
  const models = Promise.all([model(ASSETS.goldFront), model(ASSETS.goldBack), model(ASSETS.rock)]);
  /* a phone decodes the two depth maps one after the other: each needs ~100 MB on the way */
  const depth = retry(()=>decodeDepth(ASSETS.forestDepth));
  const backDepth = HI_RES ? retry(()=>decodeDepth(ASSETS.forestBackDepth, true)) : depth.then(()=>retry(()=>decodeDepth(ASSETS.forestBackDepth, true)));
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
  scene.add(makeBackdrop(imgs.forest, await depth, imgs.forestWater, imgs.forestBack, await backDepth));
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
  await nearField();
  /* the boulder's shadow is in the forest render itself; the backdrop only fills the
     floor under its foot (uFoot) */
}

export {
  loadAssets
};
