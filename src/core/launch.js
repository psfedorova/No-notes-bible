const T0 = performance.now();
const FILM = new URLSearchParams(location.search).has('film');
const intro = !FILM && window.__intro || null;
if(intro) document.documentElement.classList.add('settling');

export {
  FILM, intro, T0
};
