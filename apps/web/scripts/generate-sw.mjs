import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(path)));
    else if (entry.isFile() && entry.name !== 'sw.js') files.push(path);
  }
  return files;
}

const files = (await filesIn(dist)).sort();
const urls = files.map((file) => {
  const path = relative(dist, file).split(sep).join('/');
  return path === 'index.html'
    ? '/'
    : path.endsWith('/index.html')
      ? `/${path.slice(0, -10)}`
      : `/${path}`;
});
const hash = createHash('sha256');
for (let index = 0; index < files.length; index++) {
  hash.update(urls[index]);
  hash.update(await readFile(files[index]));
}
const version = hash.digest('hex').slice(0, 12);
const source = `const CACHE = 'etymology-shell-${version}';
const PRECACHE = ${JSON.stringify(urls)};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))), self.clients.claim()]));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname === '/healthz') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) event.waitUntil(caches.open(CACHE).then(cache => cache.put(url.pathname, response.clone())));
      return response;
    }).catch(async () => (await caches.match(url.pathname)) || (await caches.match('/'))));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, response.clone())));
    return response;
  })));
});
`;
await writeFile(join(dist, 'sw.js'), source);
console.log(`Precached ${urls.length} shell files in ${version}.`);
