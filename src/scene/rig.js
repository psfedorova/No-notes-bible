import * as THREE from 'three';
import { scene } from './renderer.js';

const floatGrp = new THREE.Group();
const spinGrp  = new THREE.Group();
const bookRoot = new THREE.Group();
scene.add(floatGrp); floatGrp.add(spinGrp); spinGrp.add(bookRoot);

export {
  bookRoot, floatGrp, spinGrp
};
