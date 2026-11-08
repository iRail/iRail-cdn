// Minimal static server for previews and offline tests: GET/HEAD, an optional public path prefix and the
// LC media types. It deliberately does NOT claim to reproduce GitHub Pages' header behavior; see check-pages.mjs.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const TYPES = { '.jsonld': 'application/ld+json', '.json': 'application/json', '.arrow': 'application/vnd.apache.arrow.file', '.html': 'text/html; charset=utf-8' };

export function serveSite(directory, { prefix = '', port = 0, cors = true, onRequest } = {}) {
  const root = path.resolve(directory);
  const server = http.createServer(async (request, response) => {
    onRequest?.(request);
    const headers = cors ? { 'access-control-allow-origin': '*' } : {};
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, headers).end(); return; }
      let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (prefix) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) { response.writeHead(404, headers).end(); return; }
        pathname = pathname.slice(prefix.length) || '/';
      }
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = path.join(root, pathname);
      if (!file.startsWith(`${root}${path.sep}`)) { response.writeHead(403, headers).end(); return; }
      const info = await stat(file);
      if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      response.writeHead(200, { ...headers, 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-length': info.size });
      if (request.method === 'HEAD') response.end(); else createReadStream(file).pipe(response);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, headers).end();
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
  })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { prefix: { type: 'string', default: '' }, port: { type: 'string', default: '8080' } } });
  const { origin } = await serveSite(positionals[0] ?? 'build/site', { prefix: values.prefix, port: Number(values.port) });
  console.log(`Serving ${positionals[0] ?? 'build/site'} at ${origin}${values.prefix}/manifest.jsonld`);
}
