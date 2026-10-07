/* the two cover boards and what is mounted on them */
import * as THREE from 'three';
import { lerp } from '../lib/textures.js';
import { CH, CVR, CW } from '../core/config.js';
import { bookRoot } from '../scene/rig.js';
import { matCoverBack, matCoverFront, matLeatherEdge } from './materials.js';
import { EP_H, EP_X0, EP_X1, HINGE_U, matEndpaper } from './paper.js';
import { backGrp, sapphire } from './sapphire.js';

function roundedRectShape(w, h, rSpine, rFore){
  const s = new THREE.Shape();
  const y0 = -h/2, y1 = h/2;
  s.moveTo(rSpine, y0);
  s.lineTo(w-rFore, y0); s.quadraticCurveTo(w, y0, w, y0+rFore);
  s.lineTo(w, y1-rFore); s.quadraticCurveTo(w, y1, w-rFore, y1);
  s.lineTo(rSpine, y1);  s.quadraticCurveTo(0, y1, 0, y1-rSpine);
  s.lineTo(0, y0+rSpine); s.quadraticCurveTo(0, y0, rSpine, y0);
  return s;
}
/* local frame: x from the spine edge outwards, z from the inner face (0) to the outer face (CVR) */
function coverBoard(matArt){
  const g = new THREE.ExtrudeGeometry(roundedRectShape(CW, CH, 0.004, 0.10), {
    depth: CVR-0.03, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 4, curveSegments: 8
  });
  g.translate(0, 0, 0.015);
  const m = new THREE.Mesh(g, [matArt, matLeatherEdge]);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
/* the pastedown stops short of the board's edges, so the leather turn-ins show;
   at the spine edge the hinge strip takes over from EP_X0, edge to edge with it.
   flipV: the front pastedown is turned over about x, so its v runs the other way */
function endpaper(flipV){
  const g = new THREE.PlaneGeometry(EP_X1 - EP_X0, EP_H);
  g.translate((EP_X0 + EP_X1)/2, 0, 0);
  const uv = g.attributes.uv;
  for(let i=0;i<uv.count;i++) uv.setXY(i, lerp(HINGE_U, 1, uv.getX(i)), flipV ? 1 - uv.getY(i) : uv.getY(i));
  const m = new THREE.Mesh(g, matEndpaper);
  m.receiveShadow = true;
  return m;
}

bookRoot.add(backGrp);
let backGoldSlot, frontGoldSlot;
{
  const board = coverBoard(matCoverBack);
  board.position.z = -CVR;
  backGrp.add(board);
  const ep = endpaper(); ep.position.z = 0.002;
  backGrp.add(ep);
  const gm = sapphire(0.6, 0.008, 0.5);
  gm.position.set(CW/2, 0, -CVR-0.008); gm.rotation.y = Math.PI;
  backGrp.add(gm);
  /* the gilt is authored with +z out of the board: flip it onto the outer face */
  backGoldSlot = new THREE.Group();
  backGoldSlot.position.z = -CVR;
  backGoldSlot.rotation.x = Math.PI;
  backGrp.add(backGoldSlot);
}
/* front board: local +z points away from the block (outer face at CVR) */
const frontGrp = new THREE.Group();
bookRoot.add(frontGrp);
let frontGem;
{
  const board = coverBoard(matCoverFront);
  frontGrp.add(board);
  const ep = endpaper(true); ep.rotation.x = Math.PI; ep.position.z = -0.002;
  frontGrp.add(ep);
  frontGem = sapphire(1.0, 0.012, 1); frontGem.position.set(CW/2, 0, CVR + 0.012);
  frontGrp.add(frontGem);
  frontGoldSlot = new THREE.Group();
  frontGoldSlot.position.z = CVR;
  frontGrp.add(frontGoldSlot);
}
frontGrp.traverse(o=>{ if(o.isMesh) o.userData.grab = 'front'; });
backGrp.traverse(o=>{ if(o.isMesh) o.userData.grab = 'back'; });

export {
  backGoldSlot, frontGem, frontGoldSlot, frontGrp
};
