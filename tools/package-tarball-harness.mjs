import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export const gattLabPackageDirectories = Object.freeze([
  'core',
  'cdp',
  'playwright',
]);

export async function packGattLabTarballs({ repositoryRoot, tarballRoot }) {
  const tarballs = {};
  for (const directory of gattLabPackageDirectories) {
    const packageRoot = resolve(repositoryRoot, 'packages', directory);
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    );
    runChecked(
      `${directory} pack`,
      'pnpm',
      ['--dir', packageRoot, 'pack', '--pack-destination', tarballRoot],
      repositoryRoot,
    );
    const tarball = resolve(
      tarballRoot,
      `gattlab-${directory}-${manifest.version}.tgz`,
    );
    await access(tarball);
    tarballs[directory] = tarball;
  }
  return Object.freeze({ ...tarballs });
}

// Clean consumers install from the store the repository populated, so
// they must request exactly the version the root manifest pins.
export async function repositoryDevDependency(repositoryRoot, name) {
  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
  );
  const version = manifest.devDependencies?.[name];
  assert.match(
    version ?? '',
    /^\d+\.\d+\.\d+$/u,
    `The root manifest must pin ${name} to an exact version.`,
  );
  return version;
}

export function gattLabTarballDependencies(tarballs) {
  return Object.fromEntries(
    gattLabPackageDirectories.map((directory) => [
      `@gattlab/${directory}`,
      `file:${tarballs[directory]}`,
    ]),
  );
}

export async function writeGattLabTarballOverrides(consumerRoot, tarballs) {
  await writeFile(
    resolve(consumerRoot, 'pnpm-workspace.yaml'),
    [
      // Network fallback resolves under the repository's release-age policy.
      'minimumReleaseAge: 1440',
      'overrides:',
      `  '@gattlab/cdp': ${JSON.stringify(`file:${tarballs.cdp}`)}`,
      `  '@gattlab/core': ${JSON.stringify(`file:${tarballs.core}`)}`,
      '',
    ].join('\n'),
  );
}

export async function assertCleanGattLabInstall({
  consumerRoot,
  repositoryRoot,
}) {
  const installedConsumerRoot = await realpath(consumerRoot);
  const installedRepositoryRoot = await realpath(repositoryRoot);
  for (const directory of gattLabPackageDirectories) {
    const installedRoot = await realpath(
      resolve(consumerRoot, 'node_modules', '@gattlab', directory),
    );
    assert.equal(
      isInside(installedConsumerRoot, installedRoot),
      true,
      `${directory} resolved outside the clean consumer: ${installedRoot}`,
    );
    assert.equal(
      isInside(installedRepositoryRoot, installedRoot),
      false,
      `${directory} resolved back into the repository workspace.`,
    );
  }
}

export function runCommand(command, args, cwd) {
  const environment = { ...process.env, NO_COLOR: '1' };
  delete environment.FORCE_COLOR;
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 20 * 1024 * 1024,
  });
}

export function runChecked(stage, command, args, cwd) {
  const result = runCommand(command, args, cwd);
  if (result.error !== undefined) {
    throw new Error(`${stage} could not start: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `${stage} failed with exit ${String(result.status)}:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

// pnpm 12 resolves offline only from its registry-metadata mirror, which a
// frozen repository install fills incompletely, and falls back to an empty
// store when the repository store cannot hard-link into the consumer
// directory. Prefer the repository store, fetch only what is missing, and skip
// resolving pnpm itself (the running pnpm already matches the pin).
export function offlineConsumerInstallArguments(consumerRoot, repositoryRoot) {
  const storeDirectory = runChecked(
    'pnpm store path',
    'pnpm',
    ['store', 'path'],
    repositoryRoot,
  );
  return [
    'install',
    '--dir',
    consumerRoot,
    '--prefer-offline',
    '--ignore-scripts',
    '--no-frozen-lockfile',
    '--config.pm-on-fail=ignore',
    `--store-dir=${storeDirectory}`,
  ];
}

function isInside(parent, candidate) {
  const path = relative(resolve(parent), resolve(candidate));
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`);
}
