// gigproxy - tiny offline-tolerant caching proxy for https://gigiau.uk
// No dependencies. Node 18+.  Usage: node proxy.js   then browse to http://localhost:8080/
//
// Env/config: PORT (8080), REFRESH_MINUTES (60), KEEP_CYCLES (3), CACHE_DIR (./cache)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 8080;
const REFRESH_MS = (+process.env.REFRESH_MINUTES || 60) * 60 * 1000;
const KEEP_CYCLES = +process.env.KEEP_CYCLES || 3; // images unseen for this many successful refreshes are deleted
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, 'cache'));
const FETCH_TIMEOUT_MS = 30000;

const SITE = 'https://gigiau.uk';
// Where the events JSON and show images come from is read from the main page on every refresh
// (see discoverSource). These are only the fallbacks used until a page has been read.
const DEFAULT_DATA = 'https://gigsmash-events-prod.s3.eu-west-2.amazonaws.com/client';
const DEFAULT_EVENTS_PATH = '/json/events.json';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i;
const ASSET_EXT = /\.(css|js|mjs|json|png|jpe?g|gif|webp|svg|ico|avif|bmp|woff2?|ttf|otf|webmanifest)$/i;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

const MANIFEST = path.join(CACHE_DIR, 'manifest.json');
// manifest: { cycle: number, images: { "<local url path>": lastSeenCycle }, lastSuccess: iso }
let manifest = { cycle: 0, images: {}, lastSuccess: null, dataSource: DEFAULT_DATA, eventsPath: DEFAULT_EVENTS_PATH, dataPrefixes: ['/json/', '/pix/'] };
try { manifest = { ...manifest, ...JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) }; } catch {}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- local url path <-> cache file -----------------------------------------------------------
// Local paths mirror the "local" platform of the site: / (page), /css/.., /json/events.json, /pix/..
// Upstream: /json/* and /pix/* come from the S3 data bucket, everything else from the site.
function upstreamFor(localPath) {
  if (manifest.dataPrefixes.some(p => localPath.startsWith(p))) return manifest.dataSource.replace(/\/+$/, '') + localPath;
  return SITE + localPath;
}

// Read the page's script to find the data source it uses, e.g.
//   var platform = "aws";  var data = { local: "", aws: "https://.../client" }[platform];
//   events = await fetch(data + "/json/events.json?v=" ...)
// Anything that can't be determined keeps its previous (persisted) value.
function discoverSource(html) {
  const plat = /\bplatform\s*=\s*["'](\w+)["']/.exec(html)?.[1]; // first assignment = the default (non-local) platform
  const obj = /\bdata\s*=\s*\{([^}]*)\}\s*\[\s*platform\s*\]/.exec(html)?.[1];
  let src;
  if (plat && obj) src = new RegExp(String.raw`\b${plat}\s*:\s*["'\x60]([^"'\x60]+)["'\x60]`).exec(obj)?.[1];
  if (!src) src = /\bdata\s*=\s*["'`](https?:\/\/[^"'`]+)["'`]/.exec(html)?.[1]; // simple form: var data = "https://..."
  if (src && /^https?:\/\//.test(src)) {
    if (src !== manifest.dataSource) log('data source:', manifest.dataSource, '->', src);
    manifest.dataSource = src;
  } else log('could not find data source in page; keeping', manifest.dataSource);
  const ev = /fetch\(\s*data\s*\+\s*["'`](\/[^"'`?]+)/.exec(html)?.[1];
  if (ev) manifest.eventsPath = ev;
  addPrefix(manifest.eventsPath);
}
function addPrefix(p) {
  const seg = /^\/[^/]+\//.exec(p)?.[0];
  if (seg && !manifest.dataPrefixes.includes(seg)) manifest.dataPrefixes.push(seg);
}
function fileFor(localPath) {
  if (localPath === '/' || localPath === '') localPath = '/index.html';
  const f = path.resolve(path.join(CACHE_DIR, 'files', '.' + localPath));
  if (!f.startsWith(path.join(CACHE_DIR, 'files') + path.sep)) return null; // traversal guard
  return f;
}

// ---- fetching --------------------------------------------------------------------------------
async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
function store(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file); // atomic: a failed/partial download never clobbers the old copy
}
async function fetchAndStore(localPath, { validate } = {}) {
  const buf = await download(upstreamFor(localPath));
  if (validate) validate(buf);
  store(fileFor(localPath), buf);
  return buf;
}

// Find asset references (quoted strings / url(...)) in html, css or js text.
// Returns normalised local paths (no query string). Only same-site references are kept.
function findAssets(text, basePath) {
  const out = new Set();
  const re = /(?:["'`(=]\s*)([^"'`()\s<>]+?\.(?:css|js|mjs|json|png|jpe?g|gif|webp|svg|ico|avif|bmp|woff2?|ttf|otf|webmanifest))(?:\?[^"'`()\s<>]*)?(?=["'`)\s>])/gi;
  let m;
  while ((m = re.exec(text))) {
    const ref = m[1];
    if (/[${}]/.test(ref) || /^(data:|mailto:|blob:|javascript:)/i.test(ref)) continue;
    try {
      const u = new URL(ref, SITE + basePath);
      if (u.origin !== SITE) continue;
      if (ASSET_EXT.test(u.pathname)) out.add(decodeURI(u.pathname));
    } catch {}
  }
  return out;
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    log('refresh: start');
    const seenImages = new Set();
    const assets = new Set();

    // 1. main page (must succeed, otherwise keep everything as is)
    const page = await fetchAndStore('/', { validate: b => { if (!/<html/i.test(b.toString('utf8', 0, 2000))) throw new Error('page does not look like HTML'); } });
    const pageText = page.toString('utf8');
    discoverSource(pageText);
    for (const a of findAssets(pageText, '/')) assets.add(a);

    // 2. the events data the page loads at runtime (must succeed too)
    const eventsBuf = await fetchAndStore(manifest.eventsPath, { validate: b => JSON.parse(b.toString('utf8')) });
    const events = JSON.parse(eventsBuf.toString('utf8'));
    for (const s of events.shows || []) {
      // image values are appended to the data source by the page; skip absolute URLs
      if (typeof s.image === 'string' && s.image.startsWith('/') && !s.image.includes('://')) { addPrefix(s.image); seenImages.add(s.image); }
    }

    // 3. ancillary content: css/js/json/images referenced by the page, plus things those reference
    const queue = [...assets];
    const done = new Set();
    while (queue.length) {
      const a = queue.shift();
      if (done.has(a)) continue;
      done.add(a);
      const isImage = IMAGE_EXT.test(a);
      if (isImage) seenImages.add(a);
      else await fetchOne(a, queue, done);
    }

    // 4. images: content behind a filename never changes, so only fetch if missing
    let got = 0, failed = 0;
    for (const img of seenImages) {
      const f = fileFor(img);
      if (f && fs.existsSync(f)) { manifest.images[img] = manifest.cycle + 1; continue; }
      try { await fetchAndStore(img); manifest.images[img] = manifest.cycle + 1; got++; }
      catch (e) { failed++; log('image failed:', e.message); if (img in manifest.images) manifest.images[img] = manifest.images[img]; }
    }

    // 5. page + data both fetched: this counts as a successful cycle. Prune stale images.
    manifest.cycle++;
    manifest.lastSuccess = new Date().toISOString();
    let deleted = 0;
    for (const [img, seen] of Object.entries(manifest.images)) {
      if (manifest.cycle - seen >= KEEP_CYCLES) {
        const f = fileFor(img);
        try { if (f) fs.rmSync(f, { force: true }); } catch {}
        delete manifest.images[img];
        deleted++;
      }
    }
    // also treat unmanifested image files from a previous run as stale-able
    saveManifest();
    log(`refresh: ok (${seenImages.size} images referenced, ${got} new, ${failed} failed, ${deleted} deleted)`);
  } catch (e) {
    log('refresh: failed, serving cached content:', e.message);
  } finally {
    refreshing = false;
  }
}
async function fetchOne(a, queue, done) {
  try {
    const buf = await fetchAndStore(a, a.endsWith('.json') ? { validate: b => JSON.parse(b.toString('utf8')) } : {});
    if (/\.(css|js|mjs)$/i.test(a)) for (const x of findAssets(buf.toString('utf8'), a)) if (!done.has(x)) queue.push(x);
  } catch (e) { log('asset failed:', e.message); }
}
function saveManifest() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
}

// ---- serving ---------------------------------------------------------------------------------
// The site's own script has a "local" mode (data from same origin: /json/events.json, /pix/...)
// triggered by location.host == "localhost". With a port in the URL that test fails (and it would
// redirect to https), so compare hostname instead.
function patchPage(html) {
  return html.replace(/location\.host\b/g, 'location.hostname');
}

const server = http.createServer((req, res) => {
  const send = (code, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
  let p;
  try { p = decodeURI(new URL(req.url, 'http://localhost').pathname); } catch { return send(400, 'Bad request'); }

  if (p === '/counter') return send(204, ''); // site's analytics ping; nothing to do offline
  if (p === '/favicon.ico' && !fs.existsSync(fileFor(p) || '')) p = '/gigiau.ico';

  const f = fileFor(p);
  if (!f || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    return send(p === '/' ? 503 : 404, p === '/' ? 'No cached copy yet - waiting for first successful download. Retry shortly.' : 'Not found');
  }
  const ext = path.extname(f).toLowerCase();
  let body = fs.readFileSync(f);
  if (f.endsWith(path.join('files', 'index.html'))) body = Buffer.from(patchPage(body.toString('utf8')));
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : body);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`gigproxy listening on http://localhost:${PORT}/  (cache: ${CACHE_DIR})`);
  refresh();
  setInterval(refresh, REFRESH_MS);
});
server.on('error', e => { console.error(e.message); process.exit(1); });
