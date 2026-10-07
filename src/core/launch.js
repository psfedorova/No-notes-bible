/* how the page was opened, read once at the start */
const T0 = performance.now();
/* ?film: the opening film is shot from this very scene, one frame at a time (film/capture.js).
   Otherwise the film plays over the page while the forest loads (film/intro.js, __intro),
   and the live book takes over from its last frame */
const FILM = new URLSearchParams(location.search).has('film');
const intro = !FILM && window.__intro || null;
if(intro) document.documentElement.classList.add('settling');

export {
  FILM, intro, T0
};
