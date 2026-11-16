import assert from 'node:assert/strict';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import {
  assertCleanGattLabInstall,
  gattLabTarballDependencies,
  offlineConsumerInstallArguments,
  repositoryDevDependency,
  runChecked,
  writeGattLabTarballOverrides,
} from './package-tarball-harness.mjs';
import {
  assertCompilerCoverage,
  assertConsumerSpecCoverage,
} from './vanilla-probe-checks.mjs';
import {
  assertBlazorAssetParity,
  assertBlazorCompilerCoverage,
  assertBlazorSpecCoverage,
  assertPublishedOnlyBlazorApplication,
} from './blazor-probe-checks.mjs';

const require = createRequire(import.meta.url);
const compilers = [
  {
    executable: require.resolve('typescript/bin/tsc'),
    version: 'Version 6.0.3',
  },
  {
    executable: require.resolve('typescript-5-9/bin/tsc'),
    version: 'Version 5.9.3',
  },
];
assert.equal(compilers.length, 2, 'Both consumer compilers are required.');
assert.equal(
  new Set(compilers.map(({ executable }) => executable)).size,
  2,
  'Consumer compilers must resolve distinct TypeScript installations.',
);

export async function prepareVanillaConsumer({
  repositoryRoot,
  consumerRoot,
  tarballs,
  additionalFixtures = [],
}) {
  runChecked(
    'Vanilla TypeScript sample build',
    'pnpm',
    ['vanilla:build'],
    repositoryRoot,
  );
  await mkdir(consumerRoot, { recursive: true });
  consumerRoot = await realpath(consumerRoot);
  await writeConsumerProject({
    repositoryRoot,
    consumerRoot,
    tarballs,
    vanilla: true,
  });
  const appRoot = resolve(consumerRoot, 'app');
  await mkdir(appRoot);
  for (const asset of ['index.html', 'styles.css', 'server.mjs', 'dist']) {
    await cp(
      resolve(repositoryRoot, 'examples/vanilla-ts', asset),
      resolve(appRoot, asset),
      { recursive: true },
    );
  }
  const fixtureFiles = await copyConsumerFixtures({
    repositoryRoot,
    consumerRoot,
    kind: 'vanilla',
    additionalFixtures,
  });
  installConsumer('Vanilla', consumerRoot, repositoryRoot);
  await assertCleanGattLabInstall({ consumerRoot, repositoryRoot });
  const checks = [];
  for (const compiler of compilers) {
    const version = compilerVersion(compiler, repositoryRoot);
    for (const target of ['sample', 'consumer']) {
      const root = target === 'sample' ? repositoryRoot : consumerRoot;
      const output = runChecked(
        `Vanilla ${target} strict check with ${version}`,
        process.execPath,
        [
          compiler.executable,
          '-p',
          target === 'sample' ? 'examples/vanilla-ts' : 'tsconfig.json',
          ...(target === 'sample' ? ['--noEmit'] : []),
          '--listFiles',
        ],
        root,
      );
      if (target === 'consumer') {
        const files = output.split(/\r?\n/u);
        assertConsumerSpecCoverage(files, consumerRoot);
        assertFixtureFileCoverage(files, fixtureFiles, consumerRoot);
      }
      checks.push({ target, version });
    }
  }
  return {
    ...consumerPaths(consumerRoot),
    compilerVersions: assertCompilerCoverage(checks),
    compilerChecks: checks,
  };
}

export async function prepareBlazorConsumer({
  repositoryRoot,
  consumerRoot,
  tarballs,
  additionalFixtures = [],
}) {
  await mkdir(consumerRoot, { recursive: true });
  consumerRoot = await realpath(consumerRoot);
  await writeConsumerProject({
    repositoryRoot,
    consumerRoot,
    tarballs,
    vanilla: false,
  });
  const appRoot = resolve(consumerRoot, 'app');
  await mkdir(resolve(appRoot, 'dist'), { recursive: true });
  await cp(
    resolve(repositoryRoot, 'examples/blazor-wasm/dist/wwwroot'),
    resolve(appRoot, 'dist/wwwroot'),
    { recursive: true },
  );
  await cp(
    resolve(repositoryRoot, 'examples/blazor-wasm/server.mjs'),
    resolve(appRoot, 'server.mjs'),
  );
  await assertPublishedOnlyBlazorApplication(appRoot);
  await assertBlazorAssetParity(
    repositoryRoot,
    resolve(appRoot, 'dist/wwwroot'),
  );
  const fixtureFiles = await copyConsumerFixtures({
    repositoryRoot,
    consumerRoot,
    kind: 'blazor',
    additionalFixtures,
  });
  installConsumer('Blazor', consumerRoot, repositoryRoot);
  await assertCleanGattLabInstall({ consumerRoot, repositoryRoot });
  const checks = [];
  for (const compiler of compilers) {
    const version = compilerVersion(compiler, consumerRoot);
    const output = runChecked(
      `Blazor consumer strict check (${version})`,
      process.execPath,
      [compiler.executable, '-p', 'tsconfig.json', '--listFiles'],
      consumerRoot,
    );
    const files = output.split(/\r?\n/u);
    assertBlazorSpecCoverage(files, consumerRoot);
    assertFixtureFileCoverage(files, fixtureFiles, consumerRoot);
    checks.push({ version });
  }
  assertBlazorCompilerCoverage(checks);
  return {
    ...consumerPaths(consumerRoot),
    compilerVersions: checks.map(({ version }) =>
      version.replace('Version ', ''),
    ),
    compilerChecks: checks,
  };
}

function compilerVersion(compiler, root) {
  const version = runChecked(
    'Consumer compiler version',
    process.execPath,
    [compiler.executable, '--version'],
    root,
  );
  assert.equal(version, compiler.version);
  return version;
}

function installConsumer(label, consumerRoot, repositoryRoot) {
  assert.equal(
    runChecked(
      'Actual consumer pnpm version',
      'pnpm',
      ['--version'],
      consumerRoot,
    ),
    '12.11.2',
  );
  runChecked(
    `${label} consumer install`,
    'pnpm',
    offlineConsumerInstallArguments(consumerRoot, repositoryRoot),
    repositoryRoot,
  );
}

async function writeConsumerProject({
  repositoryRoot,
  consumerRoot,
  tarballs,
  vanilla,
}) {
  const { packageManager } = JSON.parse(
    await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.equal(packageManager, 'pnpm@12.11.2');
  await writeFile(
    resolve(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: `gattlab-${vanilla ? 'vanilla' : 'blazor'}-application-probe`,
        private: true,
        type: 'module',
        packageManager,
        dependencies: {
          ...gattLabTarballDependencies(tarballs),
          '@playwright/test': '1.65.1',
          '@types/node': await repositoryDevDependency(
            repositoryRoot,
            '@types/node',
          ),
          ...(vanilla ? { '@types/web-bluetooth': '0.0.22' } : {}),
        },
      },
      undefined,
      2,
    )}\n`,
  );
  await writeGattLabTarballOverrides(consumerRoot, tarballs);
}

async function copyConsumerFixtures({
  repositoryRoot,
  consumerRoot,
  kind,
  additionalFixtures,
}) {
  for (const asset of ['tests', 'playwright.config.ts', 'tsconfig.json']) {
    await cp(
      resolve(repositoryRoot, 'tools', `${kind}-app-fixtures`, asset),
      resolve(consumerRoot, asset),
      { recursive: true },
    );
  }
  const files =
    kind === 'vanilla'
      ? [
          'vanilla-app.spec.ts',
          'vanilla-regression.spec.ts',
          'artifact-failure.spec.ts',
        ]
      : [
          'blazor-app.spec.ts',
          'blazor-scenarios.spec.ts',
          'artifact-failure.spec.ts',
        ];
  const required = [
    'playwright.config.ts',
    ...files.map((file) => `tests/${file}`),
    'tests/probe-support.ts',
  ];
  for (const { source, destination } of additionalFixtures) {
    await cp(source, resolve(consumerRoot, destination));
    required.push(destination);
  }
  return required;
}

function assertFixtureFileCoverage(files, required, consumerRoot) {
  for (const file of required.filter(
    (name) => name.endsWith('.ts') || name.endsWith('.mts'),
  )) {
    assert.ok(
      files.includes(resolve(consumerRoot, file)),
      `Installed consumer strict check must include ${file}.`,
    );
  }
}

function consumerPaths(consumerRoot) {
  return {
    consumerRoot,
    config: resolve(consumerRoot, 'playwright.config.ts'),
  };
}
