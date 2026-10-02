// One closed, connected boundary in millimetres. No intersecting shells.
export function makeBook(){
  const profile=[];
  const bez=(a,b,c,d,n)=>{for(let i=profile.length?1:0;i<=n;i++){const t=i/n,s=1-t;profile.push([s*s*s*a[0]+3*s*s*t*b[0]+3*s*t*t*c[0]+t*t*t*d[0],s*s*s*a[1]+3*s*s*t*b[1]+3*s*t*t*c[1]+t*t*t*d[1]]);}};
  bez([-112,1.5],[-110,1.5],[-107,1.6],[-105.8,1.8],8);
  bez([-105.8,1.8],[-105.7,8],[-105.3,19],[-105,24],8);
  bez([-105,24],[-80,34],[-55,59],[-32,50],72);
  bez([-32,50],[-10,43],[-13,5],[0,5],60);
  bez([0,5],[10,5],[15,24],[36,25],48);
  bez([36,25],[59,26],[84,18],[105,15],64);
  bez([105,15],[105.3,11],[105.7,5],[105.8,1.8],8);
  bez([105.8,1.8],[108,1.6],[110,1.5],[112,1.5],8);
  const N=profile.length, L=80, Y=20;
  const positions=[],colors=[],indices=[],lookup=new Map();
  const bottom=x=>-0.8-1.2*Math.exp(-x*x/55);
  const vertex=(x,y,z,c)=>{const key=[x,y,z].map(v=>v.toFixed(7)).join(',');if(lookup.has(key))return lookup.get(key);const id=positions.length/3;lookup.set(key,id);positions.push(x,y,z);colors.push(c,c,c);return id;};
  const at=(i,k,v)=>{
    const [x,h]=profile[i],t=k/L;
    const page=Math.min(1,Math.max(0,(106-Math.abs(x))/1.5));
    const half=74.5-4*page*Math.min(1,t*20);
    const groove=k>4&&k<L ? (k%8===0?-0.24:k%2?0.06:-0.06)*page : 0;
    const y=v*(half+groove);
    const z=bottom(x)+(h-bottom(x))*t + 1.2*Math.sin(Math.PI*(v+1)/2)*Math.sin(Math.PI*(x+112)/224)*t;
    const c=k===L?1:k<4?0.93:(k%8===0?0.64:k%2?0.96:0.87);
    return vertex(x,y,z,c);
  };
  const quad=(a,b,c,d)=>indices.push(a,b,c,a,c,d);
  // The front and back page edges have actual fine relief, joined to the covers.
  for(let i=0;i<N-1;i++)for(let k=0;k<L;k++){
    quad(at(i,k,-1),at(i+1,k,-1),at(i+1,k+1,-1),at(i,k+1,-1));
    quad(at(i,k,1),at(i,k+1,1),at(i+1,k+1,1),at(i+1,k,1));
  }
  // Outer fore-edges.
  for(let j=0;j<Y;j++)for(let k=0;k<L;k++){
    const a=-1+2*j/Y,b=-1+2*(j+1)/Y;
    quad(at(0,k,a),at(0,k+1,a),at(0,k+1,b),at(0,k,b));
    quad(at(N-1,k,a),at(N-1,k,b),at(N-1,k+1,b),at(N-1,k+1,a));
  }
  // Continuous open spread and underside; their perimeter vertices are shared.
  for(let i=0;i<N-1;i++)for(let j=0;j<Y;j++){
    const a=-1+2*j/Y,b=-1+2*(j+1)/Y;
    quad(at(i,L,a),at(i+1,L,a),at(i+1,L,b),at(i,L,b));
    quad(at(i,0,a),at(i,0,b),at(i+1,0,b),at(i+1,0,a));
  }
  return {positions,colors,indices};
}
