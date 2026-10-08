/* Stamps index.html with a content hash on every file the page loads from the repo,
   so a release refreshes all of them together and nothing else.

     node tools/stamp.mjs            (before each commit that changes src/ or css/)
     node tools/stamp.mjs --check    (exits 1 if index.html is not up to date)

   Modules import each other by plain relative paths ('./plants.js'); the importmap in
   index.html maps each of them to the same path with ?v=<hash of that file>, so a
   changed file gets a new URL and every unchanged one stays in the browser's cache.
   The <script src> and stylesheet links get the same ?v=<hash> */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'index.html');
const check = process.argv.includes('--check');

const hashOf = rel => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex').slice(0, 10);
const walk = dir => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []);

const before = fs.readFileSync(PAGE, 'utf8');
let html = before;

const MAP = /(<script type="importmap">\s*)([\s\S]*?)(\s*<\/script>)/;
const m = html.match(MAP);
if(!m) throw new Error('index.html has no <script type="importmap">');
const map = JSON.parse(m[2]);
const imports = Object.fromEntries(Object.entries(map.imports || {}).filter(([k]) => !k.startsWith('./src/')));
for(const rel of walk('src').sort()) imports[`./${rel}`] = `./${rel}?v=${hashOf(rel)}`;
map.imports = imports;
html = html.replace(MAP, (_, a, __, c) => a + JSON.stringify(map, null, 2) + c);

html = html.replace(/(<script\b[^>]*\bsrc="|<link\b[^>]*\bhref=")((?:src|css)\/[^"?]+)(?:\?v=[^"]*)?"/g,
  (_, a, rel) => `${a}${rel}?v=${hashOf(rel)}"`);

if(html === before){ console.log('index.html is up to date'); process.exit(0); }
if(check){ console.error('index.html is out of date: run node tools/stamp.mjs'); process.exit(1); }
fs.writeFileSync(PAGE, html);
const was = new Set(before.match(/(?:src|css)\/[^"?]+\?v=[0-9a-f]+/g) || []);
const now = [...new Set(html.match(/(?:src|css)\/[^"?]+\?v=[0-9a-f]+/g) || [])].filter(u => !was.has(u));
console.log(`index.html stamped, ${now.length} new:\n  ` + now.join('\n  '));
