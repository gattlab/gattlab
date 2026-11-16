import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertPublishedOnlyReactApplication,
  assertReactBuiltAssets,
  assertReactCompilerCoverage,
  assertReactProfileParity,
  assertReactReport,
  assertReactSpecCoverage,
  reactCases,
  reactDevelopmentMarker,
  reactRequiredFiles,
  readReactBundle,
} from './react-probe-checks.mjs';

function report() {
  return {
    config: { workers: 1, projects: [{ retries: 0, repeatEach: 1 }] },
    stats: { expected: 4, unexpected: 0, skipped: 0, flaky: 0 },
    errors: [],
    suites: [
      {
        specs: reactCases.map((name) => ({
          title: `${name}: browser contract`,
          tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
        })),
      },
    ],
  };
}

test('React report rejects missing/reordered/skipped/retried cases and worker/config drift', () => {
  assertReactReport(report());
  const mutations = [
    (value) => value.suites[0].specs.pop(),
    (value) => value.suites[0].specs.reverse(),
    (value) => {
      value.suites[0].specs[0].tests[0].results[0].status = 'skipped';
    },
    (value) =>
      value.suites[0].specs[0].tests[0].results.push({ status: 'passed' }),
    (value) => {
      value.suites[0].specs[0].tests[0].status = 'unexpected';
    },
    (value) => {
      value.config.workers = 2;
    },
    (value) => {
      value.config.projects[0].retries = 1;
    },
    (value) => {
      value.config.projects[0].repeatEach = 2;
    },
    (value) => {
      value.stats.skipped = 1;
    },
    (value) => value.errors.push({ message: 'global teardown failed' }),
  ];
  for (const mutate of mutations) {
    const value = report();
    mutate(value);
    assert.throws(() => assertReactReport(value));
  }
});

test('React requires both actual compilers and every spec/config/support file', () => {
  const checks = [{ version: 'Version 6.0.3' }, { version: 'Version 5.9.3' }];
  assertReactCompilerCoverage(checks);
  for (const mutation of [
    checks.slice(1),
    [checks[0], checks[0]],
    [...checks, checks[1]],
  ]) {
    assert.throws(() => assertReactCompilerCoverage(mutation));
  }
  const root = resolve('/tmp/react-coverage');
  const paths = reactRequiredFiles.map((file) => resolve(root, file));
  assertReactSpecCoverage(paths, root);
  for (const missing of paths) {
    assert.throws(
      () =>
        assertReactSpecCoverage(
          paths.filter((path) => path !== missing),
          root,
        ),
      /must include/u,
    );
  }
});

test('fixture UUID/payload parity uses actual canonical exports, including matching fixture drift', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gattlab-react-profile-'));
  try {
    const supportPath = resolve(directory, 'probe-support.ts');
    const original = await readFile(
      'tools/react-app-fixtures/tests/probe-support.ts',
      'utf8',
    );
    await writeFile(supportPath, original);
    await assertReactProfileParity(process.cwd(), supportPath);
    for (const mutation of [
      original.replace('def123457000', 'def123457099'),
      original.replace('def123457001', 'def123457098'),
      original.replace('[16, 32, 48]', '[16, 32, 49]'),
    ]) {
      await writeFile(supportPath, mutation);
      await assert.rejects(
        () => assertReactProfileParity(process.cwd(), supportPath),
        /must match canonical/u,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime/profile guards inspect reachable copied assets and reject swaps, dead markers and UUID drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gattlab-react-assets-'));
  try {
    const appRoot = resolve(root, 'app');
    const supportPath = resolve(root, 'probe-support.ts');
    await writeFile(
      supportPath,
      await readFile('tools/react-app-fixtures/tests/probe-support.ts'),
    );
    const normal =
      "const service='12345678-1234-5678-9abc-def123457000'; const io='12345678-1234-5678-9abc-def123457001'; globalThis.sample=[service,io];";
    const development = `${normal}\nconsole.info(${JSON.stringify(reactDevelopmentMarker)});`;
    for (const [name, source] of [
      ['production', normal],
      ['development', development],
    ]) {
      const directory = resolve(appRoot, 'dist', name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        resolve(directory, 'index.html'),
        '<script type="module" src="./entry.js"></script>',
      );
      await writeFile(resolve(directory, 'entry.js'), "import './runtime.js';");
      await writeFile(resolve(directory, 'runtime.js'), source);
    }
    await assertReactBuiltAssets(process.cwd(), appRoot, supportPath);
    const productionPath = resolve(appRoot, 'dist/production/runtime.js');
    const developmentPath = resolve(appRoot, 'dist/development/runtime.js');
    await writeFile(productionPath, development);
    await writeFile(developmentPath, normal);
    await assert.rejects(
      () => assertReactBuiltAssets(process.cwd(), appRoot, supportPath),
      /runtime marker/u,
    );
    await writeFile(productionPath, normal);
    await writeFile(
      resolve(appRoot, 'dist/development/unreferenced.js'),
      development,
    );
    await assert.rejects(
      () => assertReactBuiltAssets(process.cwd(), appRoot, supportPath),
      /runtime marker/u,
    );
    await writeFile(developmentPath, development);
    await writeFile(
      productionPath,
      normal.replace('def123457001', 'def123457099'),
    );
    await assert.rejects(
      () => assertReactBuiltAssets(process.cwd(), appRoot, supportPath),
      /canonical IO UUIDs/u,
    );
    await writeFile(
      productionPath,
      `${normal}\nconst extra='00002902-0000-1000-8000-00805f9b34fb';`,
    );
    await assert.rejects(
      () => assertReactBuiltAssets(process.cwd(), appRoot, supportPath),
      /canonical IO UUIDs/u,
    );
    await writeFile(productionPath, normal);
    await writeFile(resolve(appRoot, 'source.tsx'), 'export const app = 1;');
    await assert.rejects(
      () => assertPublishedOnlyReactApplication(appRoot),
      /built assets only/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bundle traversal rejects network scripts and imports escaping the copied tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gattlab-react-entries-'));
  try {
    await writeFile(
      resolve(root, 'index.html'),
      '<script src="https://example.test/app.js"></script>',
    );
    await assert.rejects(() => readReactBundle(root), /offline/u);
    await writeFile(
      resolve(root, 'index.html'),
      '<script src="./entry.js"></script>',
    );
    await writeFile(resolve(root, 'entry.js'), "import '../outside.js';");
    await assert.rejects(() => readReactBundle(root), /escape/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
