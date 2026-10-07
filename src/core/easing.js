/* easing curves and the smoothing used by every animation */
import { clamp, lerp } from '../lib/textures.js';

const easeIO = t => t<.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
const easeSine = t => 0.5 - 0.5*Math.cos(Math.PI*t);
/* a leaf is lifted gently by its corner and still falling when its back reaches the
   stack: the fore edge then comes down last, on its cushion of air */
const easeFlip = t => t*t*(3 - 2*t) + 0.55*t*t*(t - 1);
/* frame-rate independent smoothing toward a goal */
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate*dt));
/* second-order smoothing: o[k] eases toward the goal with velocity o[k+'V'],
   so motion starts and stops without a kick when the goal jumps */
function sdamp(o, k, goal, time, dt){
  const w = 2/time, x = w*dt, e = 1/(1 + x + 0.48*x*x + 0.235*x*x*x);
  const v = o[k + 'V'] || 0, d = o[k] - goal, t = (v + w*d)*dt;
  o[k + 'V'] = (v - w*t)*e;
  o[k] = goal + (d + t)*e;
  return o[k];
}
/* a released hand's motion carried on to rest: a cubic that starts at the hand's
   speed and arrives at zero speed, never past the stop; at rest it is a smoothstep
   over the usual duration, a throw only shortens it */
function glideFrom(x, v, to, base){
  const d = to - x, ad = Math.abs(d);
  let T = base;
  if(v*d > 0) T = clamp(2*ad/Math.abs(v), 0.22, base);
  const m0 = v*d > 0 ? Math.sign(d)*Math.min(Math.abs(v)*T, 2.5*ad) : clamp(v*T, -0.4*ad, 0.4*ad);
  return { x0: x, m0, to, T: Math.max(T, 1e-3), t: 0 };
}
function glideStep(gl, dt){
  gl.t = Math.min(gl.T, gl.t + dt);
  const s = gl.t/gl.T, s2 = s*s, s3 = s2*s;
  gl.x = (2*s3 - 3*s2 + 1)*gl.x0 + (s3 - 2*s2 + s)*gl.m0 + (3*s2 - 2*s3)*gl.to;
  gl.v = ((6*s2 - 6*s)*gl.x0 + (3*s2 - 4*s + 1)*gl.m0 + (6*s - 6*s2)*gl.to)/gl.T;
  return gl.t >= gl.T;
}

export {
  damp, easeFlip, easeIO, easeSine, glideFrom, glideStep, sdamp
};
