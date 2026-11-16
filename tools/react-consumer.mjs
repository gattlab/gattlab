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
  assertReactBuiltAssets,
  assertReactCompilerCoverage,
  assertReactSpecCoverage,
} from './react-probe-checks.mjs';

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
assert.equal(new Set(compilers.map(({ executable }) => executable)).size, 2);

export async function prepareReactConsumer({
  repositoryRoot,
  consumerRoot,
  tarballs,
}) {
  await mkdir(consumerRoot, { recursive: true });
  consumerRoot = await realpath(consumerRoot);
  const { packageManager } = JSON.parse(
    await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.equal(packageManager, 'pnpm@12.11.2');
  await writeFile(
    resolve(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'gattlab-react-application-probe',
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
        },
      },
      undefined,
      2,
    )}\n`,
  );
  await writeGattLabTarballOverrides(consumerRoot, tarballs);
  const appRoot = resolve(consumerRoot, 'app');
  await mkdir(appRoot);
  await cp(
    resolve(repositoryRoot, 'examples/react/dist'),
    resolve(appRoot, 'dist'),
    { recursive: true },
  );
  await cp(
    resolve(repositoryRoot, 'examples/react/server.mjs'),
    resolve(appRoot, 'server.mjs'),
  );
  for (const name of ['tests', 'playwright.config.ts', 'tsconfig.json']) {
    await cp(
      resolve(repositoryRoot, 'tools/react-app-fixtures', name),
      resolve(consumerRoot, name),
      { recursive: true },
    );
  }
  const assets = await assertReactBuiltAssets(
    repositoryRoot,
    appRoot,
    resolve(consumerRoot, 'tests/probe-support.ts'),
  );
  assert.equal(
    runChecked(
      'Actual React consumer pnpm',
      'pnpm',
      ['--version'],
      consumerRoot,
    ),
    '12.11.2',
  );
  runChecked(
    'React consumer install',
    'pnpm',
    offlineConsumerInstallArguments(consumerRoot, repositoryRoot),
    repositoryRoot,
  );
  await assertCleanGattLabInstall({ consumerRoot, repositoryRoot });
  const compilerChecks = [];
  for (const compiler of compilers) {
    const version = runChecked(
      'React consumer compiler version',
      process.execPath,
      [compiler.executable, '--version'],
      consumerRoot,
    );
    assert.equal(version, compiler.version);
    const source = runChecked(
      `React consumer strict check (${version})`,
      process.execPath,
      [compiler.executable, '-p', 'tsconfig.json', '--listFiles'],
      consumerRoot,
    );
    assertReactSpecCoverage(source.split(/\r?\n/u), consumerRoot);
    compilerChecks.push({ version });
  }
  assertReactCompilerCoverage(compilerChecks);
  return {
    consumerRoot,
    config: resolve(consumerRoot, 'playwright.config.ts'),
    compilerChecks,
    compilerVersions: compilerChecks.map(({ version }) =>
      version.replace('Version ', ''),
    ),
    assets,
  };
}
