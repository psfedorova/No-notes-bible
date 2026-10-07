# Liber Arcanum

A 3D grimoire on a mossy boulder in a forest: turn it in your hands, open it,
leaf through it and write in it. Plain HTML, CSS and ES modules with three.js
from a CDN; there is no build step. The site is served as is (GitHub Pages).

## Run it locally

```bash
python3 -m http.server 8123
```

Then open http://localhost:8123. Port 8123 matters: the Firebase key only accepts
that local address. `?intro` replays the opening film, `?emu` uses the Firebase
emulators, `?film` is the mode the film is shot in.

## Layout

```
index.html            markup only: the loading screen, the canvas, buttons, menu, pager
css/                  styles, linked from index.html in this order (the cascade relies on it)
  base.css              tokens, the page, the canvas, the hidden quill, the error strip
  controls.css          round buttons, pager, toast, the ⋯ menu, phone sizes
  intro.css             the loading circle and the opening film
  cards.css             the shortcuts card, which the Share card builds on
  shelf.css             the Share card
  invitation.css        the invitation a friend's link opens
src/
  main.js             entry point: wires the modules, boots, starts the loop
  core/               launch flags, measurements and asset paths, easing, error strip
  scene/              renderer and camera, sunbeam, post, the rig, rock, forest, plants, life
  book/               materials, paper and print, pages, boards, sapphire, spine, leaves,
                      state and layout, view and framing, turning, seeking a page, leather
  ink/                text layout, painting ink, writing, spells, saving
  fx/                 particles: embers and smoke off the ink, the magic round the book
  audio/              forest sound and the book's own sounds
  input/              picking and gestures
  ui/                 controls, the little windows, the toast
  assets/             loaders and loading every scan and model
  app/                the frame loop
  film/               intro.js (loading screen + film player), opening.js (hand-over to the
                      live book), capture.js (shoots the film under ?film)
  sharing/            shared books in Firebase (shelf.js), the invitation's magic, the config
  lib/                procedural textures and small maths helpers
assets/               audio, forest panorama, intro films, leather, plants, rock, models
firestore.rules       access rules for shared books; firebase.json points the CLI at them
tests/firestore/      rules tests against the emulator
tools/film/           shoots and encodes the opening film
blender/              (local, not in git) builds the models and the forest panorama
```

Each module starts with a line saying what it holds and ends with an `export { … }`
list of what other modules use from it. Modules import only what they need, so the
import lines show how the parts depend on each other.

## Conventions

- Text the app shows is English.
- Shared mutable values are changed only by the module that owns them, through its
  `setX()` functions; other modules read them as live imports.
- Cache busting: bump `?v=` on `src/main.js` in index.html, and on an asset's URL in
  `src/core/config.js` when the file behind it changes.
- After a visual change to the scene, the book or the opening, re-shoot the film
  (`node tools/film/shoot.mjs`), or its last frame will not match the live book.
