import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./dist/wwwroot/', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
};
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(
      new URL(request.url, 'http://localhost').pathname,
    );
    const target = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (
      !target.startsWith(`${resolve(root)}${sep}`) ||
      /[\\\0]/u.test(path) ||
      /\.(?:br|gz)$/u.test(path)
    ) {
      response.writeHead(403).end();
      return;
    }
    if (!(await stat(target)).isFile()) throw new Error('Not a file');
    // Always serve plain assets: published/source byte parity is the served parity.
    response.writeHead(200, {
      'Content-Type': types[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(Number(process.env.PORT ?? '0'), '127.0.0.1', () => {
  const address = server.address();
  console.log(`http://127.0.0.1:${address.port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close());
}
