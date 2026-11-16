import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createInterface } from 'node:readline';

import { assertVanillaApplicationBoundary } from './check-vanilla-sample.mjs';
import {
  assertCompilerCoverage,
  assertConsumerSpecCoverage,
  assertServerProcessesExited,
  cleanupServerProcesses,
} from './vanilla-probe-checks.mjs';

const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const eslint = fileURLToPath(
  new URL('../node_modules/eslint/bin/eslint.js', import.meta.url),
);
const tsc = require.resolve('typescript/bin/tsc');

test('validation contract contains every repository quality gate', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(
    packageJson.scripts.validate,
    'pnpm docs:check && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && ' +
      'pnpm packages:smoke && pnpm vanilla:probe && pnpm react:probe && pnpm command:counts && pnpm navigation:probe && pnpm toolchain:smoke',
  );
  assert.match(packageJson.scripts['test:unit'], /--allowOnly=false/u);
  assert.match(
    packageJson.scripts['test:guards'],
    /pnpm command:capacity:test && pnpm navigation:test/u,
  );
  assert.equal(
    packageJson.scripts['navigation:probe'],
    'pnpm build && node tools/navigation-app-probe.mjs',
  );
  assert.equal(
    packageJson.scripts.test,
    'pnpm test:unit && pnpm test:guards && pnpm test:playwright && ' +
      'pnpm test:playwright:isolation',
  );
  assert.equal(
    packageJson.scripts['test:playwright'],
    'playwright test --config packages/playwright/playwright.config.ts',
  );
  assert.equal(
    packageJson.scripts['test:playwright:isolation'],
    'playwright test --config packages/playwright/playwright.isolation.config.ts',
  );
  assert.equal(
    packageJson.scripts['vanilla:probe'],
    'pnpm build && node tools/vanilla-app-probe.mjs',
  );
  assert.equal(
    packageJson.scripts['security:audit'],
    'pnpm audit --audit-level high',
  );
  assert.equal(
    packageJson.scripts['react:build'],
    'node tools/react-build.mjs',
  );
  assert.equal(
    packageJson.scripts['react:probe'],
    'pnpm build && pnpm react:build && node tools/react-app-probe.mjs',
  );
  assert.equal(
    packageJson.scripts['react:test'],
    'node --test tools/react-*.test.mjs',
  );
  assert.match(
    packageJson.scripts['test:guards'],
    /&& pnpm react:test && pnpm docs:test$/u,
  );
  assert.match(
    packageJson.scripts.typecheck,
    /tsc -p examples\/react --pretty false/u,
  );
});

test('package compatibility claims stay aligned with executable guards', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const playwrightManifest = JSON.parse(
    await readFile(
      new URL('../packages/playwright/package.json', import.meta.url),
      'utf8',
    ),
  );
  const compatibilitySource = await readFile(
    new URL('../packages/playwright/src/compatibility.ts', import.meta.url),
    'utf8',
  );
  const compatibilityDocument = await readFile(
    new URL('../docs/compatibility.md', import.meta.url),
    'utf8',
  );
  const normalizedCompatibilityDocument = compatibilityDocument.replaceAll(
    /\s+/gu,
    ' ',
  );

  assert.equal(packageJson.devDependencies.typescript, '6.0.3');
  assert.equal(
    packageJson.devDependencies['typescript-5-9'],
    'npm:typescript@5.9.3',
  );
  assert.equal(
    playwrightManifest.peerDependencies['@playwright/test'],
    '>=1.65.0 <2.0.0',
  );
  for (const claim of [
    "validatedPlaywrightVersion = '1.65.1'",
    "validatedBrowserProduct = 'HeadlessChrome/159.0.8154.6'",
    "validatedBrowserVersion = '159.0.8154.6'",
    "validatedProtocolVersion = '1.3'",
  ]) {
    assert.match(compatibilitySource, new RegExp(escapeRegExp(claim), 'u'));
  }
  for (const claim of [
    'Playwright 1.65.1',
    'HeadlessChrome/159.0.8154.6',
    'browser version `159.0.8154.6`',
    'CDP protocol version `1.3`',
    '`>=1.65.0 <2.0.0`',
    'TypeScript 5.9.3',
    'TypeScript 6.0.3',
  ]) {
    assert.match(
      normalizedCompatibilityDocument,
      new RegExp(escapeRegExp(claim), 'u'),
    );
  }
});

test('dependency security automation covers packages and GitHub Actions', async () => {
  const dependabot = await readFile(
    new URL('../.github/dependabot.yml', import.meta.url),
    'utf8',
  );
  const workspace = await readFile(
    new URL('../pnpm-workspace.yaml', import.meta.url),
    'utf8',
  );

  assert.match(dependabot, /package-ecosystem: npm/u);
  assert.match(dependabot, /package-ecosystem: github-actions/u);
  assert.match(workspace, /minimumReleaseAge: 1440/u);
  assert.match(workspace, /ignoreGhsas: \[\]/u);
});

test('third-party GitHub Actions are pinned to full commit SHAs', async () => {
  const workflowsDirectory = new URL('../.github/workflows/', import.meta.url);
  const workflowNames = await readdir(workflowsDirectory);
  const actionReference = /^\s*uses:\s+([^@\s]+)@([^\s#]+)/gmu;
  let references = 0;

  for (const workflowName of workflowNames) {
    const workflow = await readFile(
      new URL(workflowName, workflowsDirectory),
      'utf8',
    );

    for (const match of workflow.matchAll(actionReference)) {
      const [, action, reference] = match;
      if (action.startsWith('./')) {
        continue;
      }
      references += 1;
      assert.match(
        reference,
        /^[0-9a-f]{40}$/u,
        `${workflowName}: ${action} must use a full commit SHA`,
      );
    }
  }

  assert.ok(references > 0, 'expected at least one third-party Action');
});

test('an intentional lint violation fails with a rule diagnostic', () => {
  const result = spawnSync(
    process.execPath,
    [
      eslint,
      '--stdin',
      '--stdin-filename',
      'tools/intentional-lint-failure.mjs',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      input: 'const unused = 1;\n',
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /no-unused-vars/);
  assert.doesNotMatch(result.stdout + result.stderr, /configuration error/i);
});

test('package lint rejects hidden nondeterminism and incomplete unions', () => {
  const result = spawnSync(
    process.execPath,
    [eslint, '--stdin', '--stdin-filename', 'packages/core/src/primitives.ts'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      input: [
        "type State = 'started' | 'stopped';",
        'declare const state: State;',
        "switch (state) { case 'started': break; }",
        'Date.now();',
        'Math.random();',
      ].join('\n'),
    },
  );

  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  assert.match(output, /switch-exhaustiveness-check/u);
  assert.match(output, /no-restricted-globals/u);
  assert.match(output, /no-restricted-properties/u);
  assert.doesNotMatch(output, /configuration error/i);
});

test('an intentional type violation fails with a compiler diagnostic', async () => {
  const fixtureDirectory = await mkdtemp(
    join(tmpdir(), 'gattlab-validation-type-error-'),
  );
  const fixture = join(fixtureDirectory, 'intentional-type-error.ts');

  try {
    await writeFile(fixture, 'const value: string = 1;\n', 'utf8');
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        '--ignoreConfig',
        '--noEmit',
        '--pretty',
        'false',
        '--strict',
        '--target',
        'ES2023',
        fixture,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /TS2322/);
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

test('Vanilla compiler evidence requires both versions for each executed target', () => {
  const checks = ['sample', 'consumer'].flatMap((target) =>
    ['Version 6.0.3', 'Version 5.9.3'].map((version) => ({ target, version })),
  );
  assert.deepEqual(assertCompilerCoverage(checks), ['6.0.3', '5.9.3']);
  for (let missing = 0; missing < checks.length; missing += 1) {
    assert.throws(
      () =>
        assertCompilerCoverage(checks.filter((_, index) => index !== missing)),
      /Both compiler versions must complete/u,
    );
  }
  assert.throws(() => assertCompilerCoverage([]), /Both compiler versions/u);
  assert.throws(
    () =>
      assertCompilerCoverage(
        checks.map((check) => ({ ...check, version: 'Version 6.0.3' })),
      ),
    /Both compiler versions/u,
  );
});

test('Vanilla compiler file evidence requires the installed floor and regression specs', () => {
  const consumerRoot = '/tmp/gattlab-compiler-consumer';
  const files = ['vanilla-app.spec.ts', 'vanilla-regression.spec.ts'].map(
    (spec) => join(consumerRoot, 'tests', spec),
  );
  assertConsumerSpecCoverage(files, consumerRoot);
  for (const missing of files) {
    assert.throws(
      () =>
        assertConsumerSpecCoverage(
          files.filter((file) => file !== missing),
          consumerRoot,
        ),
      /The installed consumer strict check must include/u,
    );
  }
  assert.throws(
    () => assertConsumerSpecCoverage(files, '/tmp/different-consumer'),
    /The installed consumer strict check must include/u,
  );
});

test(
  'Vanilla server guard detects and cleans an independently registered live process',
  { timeout: 15_000 },
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'gattlab-server-guard-'));
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 60_000);'],
      {
        stdio: 'ignore',
      },
    );
    const closed = once(child, 'close');
    void closed.catch(() => undefined);
    try {
      await once(child, 'spawn');
      await writeFile(
        join(fixture, 'server-pids.jsonl'),
        `${String(child.pid)}\n`,
      );
      await assert.rejects(assertServerProcessesExited(fixture, 1), (error) => {
        assert.match(error.message, /Leaked Vanilla application servers/u);
        assert.ok(error.message.includes(String(child.pid)));
        return true;
      });
      await cleanupServerProcesses(fixture);
      await closed;
      await assertServerProcessesExited(fixture, 1);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await closed;
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test('Vanilla server guard rejects missing registration and unsafe PID records', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'gattlab-server-records-'));
  try {
    await assertServerProcessesExited(fixture, 0);
    await assert.rejects(
      assertServerProcessesExited(fixture, 1),
      /Every sample server must register/u,
    );
    for (const pid of [0, -1, 1, process.pid, '123']) {
      await writeFile(
        join(fixture, 'server-pids.jsonl'),
        `${JSON.stringify(pid)}\n`,
      );
      await assert.rejects(
        cleanupServerProcesses(fixture),
        /Invalid sample server PID/u,
      );
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

for (const [file, reference] of [
  ['src/app.ts', "import '@gattlab/playwright';"],
  ['index.html', '<script src="/tools/test-helper.js"></script>'],
]) {
  test(`sample boundary rejects a test dependency in ${file}`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'gattlab-sample-boundary-'));
    try {
      await cp(join(repositoryRoot, 'examples/vanilla-ts'), fixture, {
        recursive: true,
      });
      await assertVanillaApplicationBoundary(fixture);
      const path = join(fixture, file);
      await writeFile(path, `${await readFile(path, 'utf8')}\n${reference}\n`);
      await assert.rejects(
        assertVanillaApplicationBoundary(fixture),
        /sample application cannot reference/u,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

test('sample lint rejects explicit any in browser TypeScript', () => {
  const result = spawnSync(
    process.execPath,
    [eslint, '--stdin', '--stdin-filename', 'examples/vanilla-ts/src/app.ts'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      input: 'export function identity(value: any) { return value; }\n',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no-explicit-any/u);
});

test(
  'standalone sample server exposes only compiled JavaScript and static assets',
  { timeout: 10_000 },
  async () => {
    const child = spawn(process.execPath, ['examples/vanilla-ts/server.mjs'], {
      cwd: repositoryRoot,
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    void closed.catch(() => undefined);
    const lines = createInterface({ input: child.stdout });
    let timeout;
    try {
      const [url] = await Promise.race([
        once(lines, 'line'),
        closed.then(() => {
          throw new Error('Sample server exited before startup.');
        }),
        new Promise((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Sample server startup deadline exceeded.')),
            5_000,
          );
        }),
      ]);
      clearTimeout(timeout);
      for (const [path, type] of [
        ['/', 'text/html'],
        ['/dist/app.js', 'text/javascript'],
        ['/dist/bluetooth-profile.js', 'text/javascript'],
        ['/styles.css', 'text/css'],
      ]) {
        const response = await fetch(new URL(path, url));
        assert.equal(response.status, 200, path);
        assert.ok(response.headers.get('content-type').startsWith(type), path);
        assert.ok((await response.text()).length > 0, path);
      }
      for (const path of [
        '/src/app.ts',
        '/dist/app.d.ts',
        '/app.js',
        '/unknown',
      ]) {
        const response = await fetch(new URL(path, url));
        assert.equal(response.status, 404, path);
        await response.text();
      }
    } finally {
      clearTimeout(timeout);
      lines.close();
      child.kill('SIGTERM');
      const killDeadline = setTimeout(() => child.kill('SIGKILL'), 1_000);
      try {
        await closed;
      } finally {
        clearTimeout(killDeadline);
      }
      assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        'Server exit is awaited.',
      );
    }
  },
);
