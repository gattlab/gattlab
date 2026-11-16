import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { buildReactBundle } from './react-build.mjs';

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'gattlab-react-build-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fakeVite(root) {
  const moduleRoot = join(root, 'node_modules/vite');
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(
    join(moduleRoot, 'package.json'),
    JSON.stringify({ type: 'module', exports: './index.js' }),
  );
  await writeFile(
    join(moduleRoot, 'index.js'),
    `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    export async function build(options) {
      if (options.build.outDir.endsWith('fail')) throw new Error('Unresolved import');
      await mkdir(options.build.outDir, {recursive:true});
      await writeFile(join(options.build.outDir, 'receipt.json'), JSON.stringify({
        nodeEnv: process.env.NODE_ENV ?? null,
        mode: options.mode,
        configFile: options.configFile,
        emptyOutDir: options.build.emptyOutDir,
      }));
    }
  `,
  );
}

test('build children receive separate explicit environments and the mode-only control removes NODE_ENV', async (t) => {
  const root = await scratch(t);
  await fakeVite(root);
  const parentEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'parent-marker';
  t.after(() => {
    if (parentEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = parentEnv;
  });
  for (const [build, modeOnly, expected] of [
    ['production', false, 'production'],
    ['development', false, 'development'],
    ['development', true, null],
  ]) {
    const outputDirectory = join(root, `${build}-${String(modeOnly)}`);
    await buildReactBundle({
      repositoryRoot: root,
      build,
      outputDirectory,
      modeOnly,
    });
    const receipt = JSON.parse(
      await readFile(join(outputDirectory, 'receipt.json'), 'utf8'),
    );
    assert.equal(receipt.nodeEnv, expected);
    assert.equal(receipt.mode, build);
    assert.equal(
      receipt.configFile,
      join(root, 'examples/react/vite.config.ts'),
    );
    assert.equal(receipt.emptyOutDir, true);
    assert.equal(process.env.NODE_ENV, 'parent-marker');
  }
});

test('build errors propagate and unsupported build names are rejected', async (t) => {
  const root = await scratch(t);
  await fakeVite(root);
  await assert.rejects(
    buildReactBundle({ repositoryRoot: root, build: 'preview' }),
    /Unknown React build/u,
  );
  await assert.rejects(
    buildReactBundle({
      repositoryRoot: root,
      outputDirectory: join(root, 'fail'),
    }),
    /build failed/u,
  );
});

async function startServer(t, root, build) {
  const child = spawn(
    process.execPath,
    [join(root, 'server.mjs'), `--build=${build}`],
    {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = once(child, 'exit');
  void exited.catch(() => undefined);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    await exited;
  });
  const lines = createInterface({ input: child.stdout });
  try {
    const [url] = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(10_000) }),
      exited.then(() => {
        throw new Error('Server exited before announcing URL');
      }),
    ]);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/u);
    return url;
  } finally {
    lines.close();
  }
}

function get(url, path) {
  return new Promise((resolveResult, reject) => {
    const address = new URL(url);
    const outgoing = request(
      { hostname: address.hostname, port: address.port, path },
      (incoming) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => {
          body += chunk;
        });
        incoming.on('end', () =>
          resolveResult({
            status: incoming.statusCode,
            type: incoming.headers['content-type'],
            body,
          }),
        );
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

test('static server isolates each build, serves MIME types and rejects traversal, symlinks and missing assets', async (t) => {
  const root = await scratch(t);
  await cp(resolve('examples/react/server.mjs'), join(root, 'server.mjs'));
  await writeFile(join(root, 'secret.js'), 'source-only');
  for (const build of ['production', 'development']) {
    const directory = join(root, 'dist', build);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'index.html'), `<p>${build}</p>`);
    await writeFile(join(directory, 'bundle.js'), `console.info('${build}');`);
    await writeFile(join(directory, 'style.css'), 'p{color:green}');
    await symlink(join(root, 'secret.js'), join(directory, 'escape.js'));
    const url = await startServer(t, root, build);
    const home = await get(url, '/');
    assert.equal(home.status, 200);
    assert.equal(home.type, 'text/html; charset=utf-8');
    assert.equal(home.body, `<p>${build}</p>`);
    assert.equal(
      (await get(url, '/bundle.js')).type,
      'text/javascript; charset=utf-8',
    );
    assert.equal(
      (await get(url, '/style.css')).type,
      'text/css; charset=utf-8',
    );
    for (const path of [
      '/missing.js',
      '/src/main.tsx',
      '/node_modules/react/index.js',
      '/dist/production/index.html',
      '/dist/development/index.html',
      '/../secret.js',
      '/%2e%2e/secret.js',
      '/..%2fsecret.js',
      '/%5c..%5csecret.js',
      '/%00',
      '/escape.js',
      '/%',
    ]) {
      const response = await get(url, path);
      assert.ok(response.status >= 400, `${build}: ${path} must not be served`);
      assert.notEqual(response.body, `<p>${build}</p>`);
    }
  }
});

test('static server rejects an unsupported build selection', async (t) => {
  const root = await scratch(t);
  await cp(resolve('examples/react/server.mjs'), join(root, 'server.mjs'));
  const child = spawn(
    process.execPath,
    [join(root, 'server.mjs'), '--build=source'],
    { stdio: 'ignore' },
  );
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
});
