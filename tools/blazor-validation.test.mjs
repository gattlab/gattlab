import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import {
  assertBlazorCompilerCoverage,
  assertBlazorReport,
  assertBlazorSpecCoverage,
  blazorScenarioCases,
  blazorSmokeCases,
} from './blazor-probe-checks.mjs';
import {
  assertBlazorScripts,
  assertBlazorWorkflow,
} from './blazor-validation-checks.mjs';
import { assertServerProcessesExited } from './vanilla-probe-checks.mjs';

test('mandatory Blazor CI SDK/job/command and Node-only base contract cannot disappear', async () => {
  const workflow = await readFile('.github/workflows/validate.yml', 'utf8');
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
  assertBlazorWorkflow(workflow);
  assertBlazorScripts(scripts);
  for (const mutation of [
    workflow.split('\n  blazor:')[0],
    workflow.replace(
      'global-json-file: examples/blazor-wasm/global.json',
      'dotnet-version: latest',
    ),
    workflow.replace('run: pnpm blazor:validate', 'run: true'),
    workflow.replace(
      'name: Blazor sample validation',
      'name: Blazor sample validation\n    if: false',
    ),
    `${workflow}\n    continue-on-error: true`,
    workflow.replace('if: always()', 'if: false'),
    workflow.replace(
      'run: pnpm validate',
      'if: always()\n        run: pnpm validate',
    ),
    workflow.replace(
      'run: pnpm blazor:validate',
      'if: always()\n        run: pnpm blazor:validate',
    ),
  ])
    assert.throws(() => assertBlazorWorkflow(mutation), /Blazor/u);
  for (const key of [
    'blazor:build',
    'blazor:probe',
    'blazor:validate',
    'test:guards',
  ]) {
    assert.throws(() => assertBlazorScripts({ ...scripts, [key]: 'true' }));
  }
});

test('sample-local SDK/framework/lock pins and consumer strict settings remain exact', async () => {
  const root = 'examples/blazor-wasm';
  const global = JSON.parse(await readFile(`${root}/global.json`, 'utf8'));
  assert.deepEqual(global.sdk, {
    version: '10.0.401',
    rollForward: 'disable',
    allowPrerelease: false,
  });
  const project = await readFile(`${root}/GattLab.BlazorSample.csproj`, 'utf8');
  assert.match(project, /TargetFramework>net10.0</u);
  assert.match(project, /TreatWarningsAsErrors>true</u);
  assert.match(project, /Nullable>enable</u);
  assert.match(project, /RuntimeFrameworkVersion>10.0.10</u);
  assert.match(
    project,
    /Microsoft.AspNetCore.Components.WebAssembly" Version="\[10.0.10\]"/u,
  );
  assert.doesNotMatch(project, /DevServer|Server|Auto|AOT/u);
  const lock = JSON.parse(await readFile(`${root}/packages.lock.json`, 'utf8'));
  assert.equal(
    lock.dependencies['net10.0']['Microsoft.AspNetCore.Components.WebAssembly']
      .resolved,
    '10.0.10',
  );
  const build = await readFile('tools/blazor-build.mjs', 'utf8');
  assert.match(build, /'restore', '--locked-mode'/u);
  assert.match(build, /'--no-restore'/u);
  const tsconfig = JSON.parse(
    await readFile('tools/blazor-app-fixtures/tsconfig.json', 'utf8'),
  );
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.skipLibCheck, false);
  assert.equal(tsconfig.compilerOptions.allowJs, undefined);
  assert.equal(tsconfig.compilerOptions.checkJs, undefined);
  assert.equal(tsconfig.compilerOptions.noEmit, true);
});

test('both actual compilers and spec/config/support coverage are independently required', () => {
  const checks = [{ version: 'Version 6.0.3' }, { version: 'Version 5.9.3' }];
  assertBlazorCompilerCoverage(checks);
  for (const missing of [0, 1])
    assert.throws(
      () =>
        assertBlazorCompilerCoverage(
          checks.filter((_check, index) => index !== missing),
        ),
      /Both Blazor/u,
    );
  const files = [
    'playwright.config.ts',
    'tests/blazor-app.spec.ts',
    'tests/blazor-scenarios.spec.ts',
    'tests/artifact-failure.spec.ts',
    'tests/probe-support.ts',
  ].map((file) => resolve('/consumer', file));
  assertBlazorSpecCoverage(files, '/consumer');
  for (const missing of [0, 1, 2, 3, 4])
    assert.throws(
      () =>
        assertBlazorSpecCoverage(
          files.filter((_file, index) => index !== missing),
          '/consumer',
        ),
      /strict check must include/u,
    );
});

test('skipped/missing/repeated smoke cases cannot claim 3 passing tests', () => {
  const good = {
    config: { workers: 1 },
    stats: { expected: 3, unexpected: 0, skipped: 0, flaky: 0 },
    errors: [],
    suites: [
      {
        specs: [1, 2, 3].map((index) => ({
          title: `B${index}: case`,
          tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
        })),
      },
    ],
  };
  assertBlazorReport(good);
  for (const index of [0, 1, 2]) {
    const missing = structuredClone(good);
    missing.suites[0].specs.splice(index, 1);
    assert.throws(() => assertBlazorReport(missing), /All 3 Blazor cases/u);
    const skipped = structuredClone(good);
    skipped.suites[0].specs[index].tests[0].results[0].status = 'skipped';
    assert.throws(() => assertBlazorReport(skipped), /must pass/u);
  }
  const repeated = structuredClone(good);
  repeated.suites[0].specs[0].tests[0].results.push({ status: 'passed' });
  assert.throws(() => assertBlazorReport(repeated), /No retries/u);
});

test('the scenario report requires E1–E5, L1, L2a, L2b and L3 once, in order', () => {
  const report = (titles) => ({
    config: { workers: 1 },
    stats: { expected: titles.length, unexpected: 0, skipped: 0, flaky: 0 },
    errors: [],
    suites: [
      {
        specs: titles.map((title) => ({
          title: `${title}: case`,
          tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
        })),
      },
    ],
  });
  assertBlazorReport(report(blazorScenarioCases), blazorScenarioCases);
  assert.throws(
    () => assertBlazorReport(report(blazorSmokeCases), blazorScenarioCases),
    /All 9 Blazor cases/u,
  );
  const withoutL2b = blazorScenarioCases.filter((title) => title !== 'L2b');
  assert.throws(
    () => assertBlazorReport(report(withoutL2b), blazorScenarioCases),
    /All 9 Blazor cases/u,
  );
  const reordered = [...blazorScenarioCases];
  [reordered[6], reordered[7]] = [reordered[7], reordered[6]];
  assert.throws(
    () => assertBlazorReport(report(reordered), blazorScenarioCases),
    /reordered Blazor case L2a/u,
  );
});

test('one registered server must be present and dead after the passing run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gattlab-blazor-pids-'));
  try {
    await assert.rejects(
      assertServerProcessesExited(root, 1),
      /register its PID/u,
    );
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const exited = once(child, 'close');
    try {
      await once(child, 'spawn');
      await writeFile(resolve(root, 'server-pids.jsonl'), `${child.pid}\n`);
      await assert.rejects(assertServerProcessesExited(root, 1), /Leaked/u);
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
    await assertServerProcessesExited(root, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('static server serves plain publish assets, MIME types and rejects source/traversal/missing framework', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gattlab-blazor-server-'));
  let child;
  let exited;
  try {
    await mkdir(resolve(root, 'dist/wwwroot/_framework'), { recursive: true });
    await cp('examples/blazor-wasm/server.mjs', resolve(root, 'server.mjs'));
    await writeFile(resolve(root, 'Program.cs'), 'not public');
    for (const [asset, contents] of [
      ['index.html', '<html>published</html>'],
      ['bluetooth.js', 'export const plain = true;'],
      ['styles.css', 'body {}'],
      ['_framework/test.wasm', 'binary'],
      ['_framework/test.json', '{}'],
      ['_framework/test.dat', 'binary'],
      ['bluetooth.js.br', 'wrong compressed bytes'],
    ]) {
      await writeFile(resolve(root, 'dist/wwwroot', asset), contents);
    }
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = once(child, 'close');
    const lines = createInterface({ input: child.stdout });
    let timer;
    const url = await Promise.race([
      once(lines, 'line').then(([line]) => line),
      exited.then(() => {
        throw new Error('Static server exited before URL');
      }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Static server startup deadline')),
          5000,
        );
      }),
    ]).finally(() => {
      clearTimeout(timer);
      lines.close();
    });
    assert.equal(new URL(url).hostname, '127.0.0.1');
    for (const [asset, type] of [
      ['bluetooth.js', 'text/javascript'],
      ['styles.css', 'text/css'],
      ['_framework/test.wasm', 'application/wasm'],
      ['_framework/test.json', 'application/json'],
      ['_framework/test.dat', 'application/octet-stream'],
    ]) {
      const response = await fetch(`${url}/${asset}`, {
        headers: { 'Accept-Encoding': 'br, gzip' },
      });
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type').startsWith(type));
      assert.equal(response.headers.get('content-encoding'), null);
      if (asset === 'bluetooth.js')
        assert.equal(await response.text(), 'export const plain = true;');
      else await response.arrayBuffer();
    }
    for (const path of [
      '/Program.cs',
      '/_framework/missing.wasm',
      '/%2e%2e%2fProgram.cs',
      '/bluetooth.js.br',
    ]) {
      const response = await fetch(url + path);
      assert.ok(
        response.status >= 400,
        `${path} must not serve source or HTML fallback`,
      );
      await response.arrayBuffer();
    }
  } finally {
    child?.kill('SIGTERM');
    if (exited) await exited;
    await rm(root, { recursive: true, force: true });
  }
});
