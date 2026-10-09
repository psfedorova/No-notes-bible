# Liber Arcanum

A 3D grimoire on a mossy boulder in a forest: turn it in your hands, open it,
leaf through it and write in it. Plain HTML, CSS and ES modules with three.js
from a CDN; there is no build step. The site is served as is (GitHub Pages).

## Run it locally

```bash
python3 -m http.server 8123
```

Then open http://localhost:8123. Port 8123 matters: the Firebase key only accepts
that local address. `?intro` replays the opening, `?emu` uses the Firebase
emulators, `?film` is the mode the opening is shot as a video in, `?pr=1.5` pins the pixel ratio
(a phone's frame loop otherwise steps it down when its GPU cannot keep up).

## Layout

```
index.html            markup only: the loading screen, the canvas, buttons, menu, pager
css/                  styles, linked from index.html in this order (the cascade relies on it)
  base.css              tokens, the page, the canvas, the hidden quill, the error strip
  controls.css          round buttons, pager, toast, the ⋯ menu, phone sizes
  intro.css             the loading circle and the veil it lifts off the opening
  cards.css             the shortcuts card, which the Share card builds on
  shelf.css             the Share card
  invitation.css        the invitation a friend's link opens
src/
  main.js             entry point: wires the modules, boots, starts the loop
  core/               launch flags, measurements and asset paths, easing, error strip
  scene/              renderer and camera, sunbeam, soft dust and glow, post, the rig, rock, forest, plants, life
  book/               materials, paper and print, pages, boards, sapphire, spine, leaves,
                      state and layout, view and framing, turning, seeking a page, leather
  ink/                text layout, painting ink, writing, spells, saving
  fx/                 particles: embers and smoke off the ink, the magic round the book
  audio/              forest sound and the book's own sounds
  input/              picking and gestures
  ui/                 controls, the little windows, the toast
  assets/             loaders, loading in two parts (all in view first, then the sharper
                      forest), the worker that decodes the forest's depth
  app/                the frame loop
  film/               intro.js (loading screen), capture.js (the opening's story, played live
                      on the scene, or shot as a video under ?film), opening.js (its hooks
                      in the scene and the hand-over to the reader)
  sharing/            shared books in Firebase (shelf.js), the invitation's magic, the config
  lib/                procedural textures, value noise from a 3D texture, small maths helpers
assets/               audio, forest panorama, the opening's music, leather, rock, models,
                      plants (Draco + WebP .glb, made with gltf-transform)
firestore.rules       access rules for shared books; firebase.json points the CLI at them
tests/firestore/      rules tests against the emulator
tools/film/           shoots and encodes the opening film
tools/stamp.mjs       stamps index.html with a content hash on every script, module and stylesheet
tools/webp.mjs        packs the forest depth, water and leaf PNGs into lossless WebP for the page
blender/              (local, not in git) builds the models and the forest panorama
```

Each module starts with a line saying what it holds and ends with an `export { … }`
list of what other modules use from it. Modules import only what they need, so the
import lines show how the parts depend on each other.

## Conventions

- Text the app shows is English.
- Shared mutable values are changed only by the module that owns them, through its
  `setX()` functions; other modules read them as live imports.
- Cache busting: run `node tools/stamp.mjs` before committing a change to `src/` or
  `css/` (see Releasing). Bump `?v=` by hand only on an asset's URL in `src/core/config.js`
  when the file behind it changes. After editing a depth, water or leaf PNG, run
  `node tools/webp.mjs`: the page loads the WebP copies, not the PNGs.
- The opening plays live on the scene itself, so a change to the scene or the book
  needs no re-shoot. `node tools/film/shoot.mjs` still renders it as a video to share.

## Releasing

Modules import each other by plain relative paths, and a browser caches each file on
its own. Bumping only `src/main.js?v=` would leave the other modules cached, and a new
module could then load beside a stale one (a shader built from both fails to compile).
So before each commit that changes `src/` or `css/`:

```bash
node tools/stamp.mjs
```

It hashes every file under `src/` and rewrites the importmap in index.html so that each
module path maps to the same path with `?v=<hash>`. It also stamps the `<script src>` and
stylesheet links. A changed file gets a new URL, and every unchanged one keeps its URL and
stays in the visitor's cache. The source files are not touched. `node tools/stamp.mjs
--check` exits with 1 when index.html is out of date (for a pre-commit hook or CI).

What follows from this:

- Code that builds a URL to one of its own files goes through the importmap with
  `import.meta.resolve('./x.js')`, not `new URL('./x.js', import.meta.url)`, which skips
  the map and so loses the version (the depth worker in `src/scene/forest.js` does this).
- While working locally, run the stamp after an edit too, or tick Disable cache in
  DevTools. `python3 -m http.server` sends no Cache-Control, so the browser may keep using
  an older copy of a file whose URL did not change.
