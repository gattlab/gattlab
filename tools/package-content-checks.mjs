import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import {
  gattLabPackageDirectories,
  runChecked,
} from './package-tarball-harness.mjs';

// Unmodified English text: https://www.apache.org/licenses/LICENSE-2.0.txt
export const apacheLicenseSha256 =
  'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';

// The appendix boilerplate line carries the approved copyright holder; every
// other byte stays identical to the authoritative Apache-2.0 text.
const licensePlaceholderLine =
  '   Copyright [yyyy] [name of copyright owner]\n';
export const licenseCopyrightLine = '   Copyright 2026 Jakub Grzywaczewski\n';

export function isApprovedLicense(bytes) {
  if (!bytes) return false;
  const text = Buffer.from(bytes).toString('utf8');
  if (text.split(licenseCopyrightLine).length !== 2) return false;
  if (text.includes(licensePlaceholderLine)) return false;
  const restored = text.replace(licenseCopyrightLine, licensePlaceholderLine);
  return (
    createHash('sha256').update(restored).digest('hex') === apacheLicenseSha256
  );
}

export const publishedPackageFiles = Object.freeze([
  'dist/**/*.d.ts',
  'dist/**/*.d.ts.map',
  'dist/**/*.js',
  'dist/**/*.js.map',
  'LICENSE',
  'NOTICE',
]);

export function publicationMetadata(directory) {
  assert(
    gattLabPackageDirectories.includes(directory),
    'Unknown public package.',
  );
  return {
    license: 'Apache-2.0',
    repository: {
      type: 'git',
      url: 'git+https://github.com/gattlab/gattlab.git',
      directory: `packages/${directory}`,
    },
    homepage: `https://github.com/gattlab/gattlab/tree/main/packages/${directory}#readme`,
    bugs: { url: 'https://github.com/gattlab/gattlab/issues' },
    publishConfig: {
      access: 'public',
      registry: 'https://registry.npmjs.org/',
    },
  };
}

export function assertPublicationManifest(manifest, directory, version) {
  assert.equal(manifest.name, `@gattlab/${directory}`);
  if (version !== undefined) assert.equal(manifest.version, version);
  assert(
    manifest.private === undefined || manifest.private === false,
    'Package publication preparation remains blocked.',
  );
  for (const [field, expected] of Object.entries(
    publicationMetadata(directory),
  ))
    assert.deepEqual(manifest[field], expected, `Unexpected package ${field}.`);
  assert.deepEqual(manifest.files, publishedPackageFiles);
}

// The expected output set remains source-derived, as in the package smoke.
export async function expectedTarballEntries(packageRoot) {
  const license = await readFile(resolve(packageRoot, '../../LICENSE'));
  assert(
    isApprovedLicense(license),
    'Root LICENSE differs from the authoritative Apache-2.0 text with the approved copyright line.',
  );
  assert.deepEqual(
    await readFile(resolve(packageRoot, 'LICENSE')),
    license,
    'Package LICENSE differs from root LICENSE.',
  );
  const entries = [
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
  ];
  const rootNotice = await readFile(resolve(packageRoot, '../../NOTICE')).catch(
    (error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (rootNotice) {
    assert.deepEqual(
      await readFile(resolve(packageRoot, 'NOTICE')),
      rootNotice,
      'Package NOTICE differs from root NOTICE.',
    );
    entries.push('package/NOTICE');
  }
  const sourceRoot = resolve(packageRoot, 'src');
  for (const sourceModule of await listSourceModules(sourceRoot, sourceRoot)) {
    const outputStem = sourceModule.slice(0, -'.ts'.length);
    for (const extension of ['.d.ts', '.d.ts.map', '.js', '.js.map']) {
      entries.push(`package/dist/${outputStem}${extension}`);
    }
  }
  return entries.sort();
}

export async function auditPackedContent({ repositoryRoot, tarballs }) {
  const hashes = {};
  for (const directory of gattLabPackageDirectories) {
    const tarball = tarballs[directory];
    const entries = runChecked(
      `${directory} tarball listing`,
      'tar',
      ['-tzf', tarball],
      repositoryRoot,
    )
      .split('\n')
      .filter(Boolean);
    const expected = await expectedTarballEntries(
      resolve(repositoryRoot, 'packages', directory),
    );
    const actual = [...new Set(entries)].sort();
    assert.equal(
      actual.length,
      entries.length,
      `${directory} tarball contains duplicate entries.`,
    );
    assert.deepEqual(
      {
        missing: expected.filter((entry) => !actual.includes(entry)),
        unexpected: actual.filter((entry) => !expected.includes(entry)),
      },
      { missing: [], unexpected: [] },
      `${directory} tarball contents do not exactly match source modules.`,
    );

    const contentHash = createHash('sha256');
    contentHash.update('gattlab-packed-content-v1\0');
    for (const entry of actual) {
      const result = spawnSync('tar', ['-xOf', tarball, entry], {
        cwd: repositoryRoot,
        maxBuffer: 20 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      assert.equal(
        result.status,
        0,
        `${directory} tarball member ${entry} could not be read.`,
      );
      const name = Buffer.from(entry.slice('package/'.length), 'utf8');
      const bytes = result.stdout;
      if (entry === 'package/LICENSE' || entry === 'package/NOTICE')
        assert.deepEqual(
          bytes,
          await readFile(
            resolve(
              repositoryRoot,
              'packages',
              directory,
              entry.slice('package/'.length),
            ),
          ),
          `${directory} packed legal text differs from its source.`,
        );
      // Length framing distinguishes filenames and arbitrary binary contents.
      contentHash.update(`${String(name.length)}:`);
      contentHash.update(name);
      contentHash.update(`${String(bytes.length)}:`);
      contentHash.update(bytes);
    }
    hashes[directory] = Object.freeze({
      tarballSha256: createHash('sha256')
        .update(await readFile(tarball))
        .digest('hex'),
      contentSha256: contentHash.digest('hex'),
      entries: actual.length,
    });
  }
  return Object.freeze(hashes);
}

async function listSourceModules(sourceRoot, directory) {
  const modules = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      modules.push(...(await listSourceModules(sourceRoot, path)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      modules.push(relative(sourceRoot, path).split(sep).join('/'));
    }
  }
  return modules;
}
