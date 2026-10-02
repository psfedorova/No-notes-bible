import {makeBook} from '../book-model.mjs';
import fs from 'node:fs';
const {positions:p,indices:f}=makeBook();
const edges=new Map(),adj=Array.from({length:p.length/3},()=>[]);let volume=0;
for(let i=0;i<f.length;i+=3){const [a,b,c]=f.slice(i,i+3);for(const [u,v] of [[a,b],[b,c],[c,a]]){const key=[Math.min(u,v),Math.max(u,v)].join(',');const e=edges.get(key)||[0,0];e[0]++;e[1]+=u<v?1:-1;edges.set(key,e);adj[u].push(v);adj[v].push(u);}const A=p.slice(a*3,a*3+3),B=p.slice(b*3,b*3+3),C=p.slice(c*3,c*3+3);volume+=(A[0]*(B[1]*C[2]-B[2]*C[1])+A[1]*(B[2]*C[0]-B[0]*C[2])+A[2]*(B[0]*C[1]-B[1]*C[0]))/6;}
const seen=new Set([0]),q=[0];while(q.length){for(const v of adj[q.pop()])if(!seen.has(v)){seen.add(v);q.push(v);}}
const bad=[...edges.values()].filter(([n,w])=>n!==2||w!==0).length;
if(bad||seen.size!==p.length/3||volume<=0||p.some(x=>!Number.isFinite(x)))throw Error(JSON.stringify({bad,connected:seen.size,vertices:p.length/3,volume}));
let obj='# Open book. Single connected closed mesh. Units: millimetres.\no OpenBook\ns 1\n';for(let i=0;i<p.length;i+=3)obj+=`v ${p[i].toFixed(6)} ${p[i+1].toFixed(6)} ${p[i+2].toFixed(6)}\n`;for(let i=0;i<f.length;i+=3)obj+=`f ${f[i]+1} ${f[i+1]+1} ${f[i+2]+1}\n`;fs.writeFileSync(new URL('open-book.obj',import.meta.url),obj);
console.log({vertices:p.length/3,triangles:f.length/3,nonManifoldEdges:bad,components:1,volumeMm3:Math.round(volume)});
