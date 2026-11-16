import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (
  args.length > 1 ||
  (args[0] !== undefined &&
    !/^--build=(?:production|development)$/u.test(args[0]))
) {
  throw new Error('Usage: node server.mjs [--build=production|development]');
}
const build = args[0]?.slice('--build='.length) ?? 'production';
const root = await realpath(
  fileURLToPath(new URL(`./dist/${build}/`, import.meta.url)),
);
const port = Number(process.env.PORT ?? '0');
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error('PORT must be an integer from 0 to 65535.');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
    if (
      !path.startsWith('/') ||
      /[\\\0]/u.test(path) ||
      path.split('/').includes('..')
    ) {
      response.writeHead(403).end();
      return;
    }
    const target = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    const canonical = await realpath(target);
    if (
      !canonical.startsWith(`${root}${sep}`) ||
      !(await stat(canonical)).isFile()
    ) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': types[extname(canonical)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(await readFile(canonical));
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(`http://127.0.0.1:${address.port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close());
}
