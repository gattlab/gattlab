import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const applicationRoot = new URL('./', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/dist/app.js', ['dist/app.js', 'text/javascript; charset=utf-8']],
  [
    '/dist/bluetooth-profile.js',
    ['dist/bluetooth-profile.js', 'text/javascript; charset=utf-8'],
  ],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

export function startVanillaApplicationServer({ port = 0 } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const asset = assets.get(requestUrl.pathname);
      if (request.method !== 'GET' || asset === undefined) {
        response.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('Not found');
        return;
      }
      const [fileName, contentType] = asset;
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentType,
      });
      response.end(await readFile(new URL(fileName, applicationRoot)));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new TypeError('Expected a TCP application-server address.'));
        return;
      }
      resolve({
        server,
        url: `http://127.0.0.1:${String(address.port)}`,
      });
    });
  });
}

export function stopVanillaApplicationServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const port = Number.parseInt(process.env.PORT ?? '4173', 10);
  const application = await startVanillaApplicationServer({ port });
  process.stdout.write(`${application.url}\n`);
}
