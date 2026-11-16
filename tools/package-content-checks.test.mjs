import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  auditPackedContent,
  assertPublicationManifest,
  publicationMetadata,
  publishedPackageFiles,
} from './package-content-checks.mjs';

const members = [
  'package/README.md',
  'package/package.json',
  'package/LICENSE',
  'package/dist/index.d.ts',
  'package/dist/index.d.ts.map',
  'package/dist/index.js',
  'package/dist/index.js.map',
];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gattlab-content-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const license = await readFile(new URL('../LICENSE', import.meta.url));
  await writeFile(resolve(root, 'LICENSE'), license);
  for (const directory of ['core', 'cdp', 'playwright']) {
    await mkdir(resolve(root, 'packages', directory, 'src'), {
      recursive: true,
    });
    await writeFile(
      resolve(root, 'packages', directory, 'src/index.ts'),
      'export {};\n',
    );
    await writeFile(resolve(root, 'packages', directory, 'LICENSE'), license);
  }
  await mkdir(resolve(root, 'package/dist'), { recursive: true });
  for (const member of members) {
    await writeFile(
      resolve(root, member),
      member.endsWith('/LICENSE')
        ? license
        : member.endsWith('.js')
          ? Buffer.from([255, 0])
          : member,
    );
  }
  return root;
}

function pack(root, label, selected = members) {
  const file = resolve(root, `${label}.tgz`);
  const result = spawnSync('tar', ['-czf', file, '-C', root, ...selected], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(
    ['core', 'cdp', 'playwright'].map((directory) => [directory, file]),
  );
}

test('packed content digest ignores archive timestamps while retaining tarball identity', async (t) => {
  const root = await fixture(t);
  for (const member of members)
    await utimes(resolve(root, member), 1_577_836_800, 1_577_836_800);
  const first = await auditPackedContent({
    repositoryRoot: root,
    tarballs: pack(root, 'first'),
  });
  for (const member of members)
    await utimes(resolve(root, member), 1_609_459_200, 1_609_459_200);
  const second = await auditPackedContent({
    repositoryRoot: root,
    tarballs: pack(root, 'second', [...members].reverse()),
  });
  for (const directory of ['core', 'cdp', 'playwright']) {
    assert.notEqual(
      first[directory].tarballSha256,
      second[directory].tarballSha256,
    );
    assert.equal(
      first[directory].contentSha256,
      second[directory].contentSha256,
    );
  }
});

test('publication metadata rejects another namespace, private flags and incorrect destinations', () => {
  const manifest = {
    name: '@gattlab/core',
    version: '0.1.0-alpha',
    files: [...publishedPackageFiles],
    ...publicationMetadata('core'),
  };
  assert.doesNotThrow(() =>
    assertPublicationManifest(manifest, 'core', '0.1.0-alpha'),
  );
  for (const mutate of [
    (m) => {
      m.name = 'gattlab';
    },
    (m) => {
      m.name = '@other/core';
    },
    (m) => {
      m.private = true;
    },
    (m) => {
      m.version = '0.2.0';
    },
    (m) => {
      delete m.license;
    },
    (m) => {
      m.publishConfig.registry = 'https://registry.example.invalid/';
    },
    (m) => {
      m.publishConfig.access = 'restricted';
    },
    (m) => {
      m.repository.directory = 'packages/cdp';
    },
    (m) => {
      m.repository.url = 'git+https://github.com/other/project.git';
    },
    (m) => {
      m.files.push('src/**');
    },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    assert.throws(() =>
      assertPublicationManifest(changed, 'core', '0.1.0-alpha'),
    );
  }
  assert.throws(() => publicationMetadata('other'), /Unknown public package/u);
});

test('legal content audit rejects altered license text and lost attribution', async (t) => {
  const root = await fixture(t);
  await writeFile(
    resolve(root, 'package/LICENSE'),
    'Apache License\nIncomplete copy.\n',
  );
  await assert.rejects(
    auditPackedContent({
      repositoryRoot: root,
      tarballs: pack(root, 'bad-license'),
    }),
    /packed legal text differs/u,
  );
  const license = await readFile(resolve(root, 'LICENSE'));
  await writeFile(resolve(root, 'package/LICENSE'), license);
  await writeFile(resolve(root, 'NOTICE'), 'Synthetic fixture attribution.\n');
  await assert.rejects(
    auditPackedContent({
      repositoryRoot: root,
      tarballs: pack(root, 'lost-notice'),
    }),
    /ENOENT/u,
  );
  for (const directory of ['core', 'cdp', 'playwright'])
    await writeFile(
      resolve(root, 'packages', directory, 'NOTICE'),
      'Synthetic fixture attribution.\n',
    );
  await assert.rejects(
    auditPackedContent({
      repositoryRoot: root,
      tarballs: pack(root, 'missing-notice'),
    }),
    /do not exactly match source modules/u,
  );
  await writeFile(
    resolve(root, 'package/NOTICE'),
    'Synthetic fixture attribution.\n',
  );
  await auditPackedContent({
    repositoryRoot: root,
    tarballs: pack(root, 'valid-notice', [...members, 'package/NOTICE']),
  });
  await writeFile(
    resolve(root, 'package/NOTICE'),
    'Changed fixture attribution.\n',
  );
  await assert.rejects(
    auditPackedContent({
      repositoryRoot: root,
      tarballs: pack(root, 'changed-notice', [...members, 'package/NOTICE']),
    }),
    /packed legal text differs/u,
  );
  await writeFile(
    resolve(root, 'package/NOTICE'),
    'Synthetic fixture attribution.\n',
  );
  await writeFile(
    resolve(root, 'packages/core/LICENSE'),
    'Altered package license.\n',
  );
  await assert.rejects(
    auditPackedContent({
      repositoryRoot: root,
      tarballs: pack(root, 'source-drift', [...members, 'package/NOTICE']),
    }),
    /Package LICENSE differs/u,
  );
  await writeFile(resolve(root, 'packages/core/LICENSE'), license);
  await writeFile(
    resolve(root, 'LICENSE'),
    'Apache License\nIncomplete root.\n',
  );
  await assert.rejects(
    auditPackedContent({
      repositoryRoot: root,
      tarballs: pack(root, 'root-drift', [...members, 'package/NOTICE']),
    }),
    /authoritative Apache/u,
  );
});

test('packed content digest preserves binary differences lost by UTF-8 decoding', async (t) => {
  const root = await fixture(t);
  const first = await auditPackedContent({
    repositoryRoot: root,
    tarballs: pack(root, 'first'),
  });
  await writeFile(
    resolve(root, 'package/dist/index.js'),
    Buffer.from([254, 0]),
  );
  assert.equal(
    Buffer.from([255, 0]).toString('utf8'),
    Buffer.from([254, 0]).toString('utf8'),
  );
  const second = await auditPackedContent({
    repositoryRoot: root,
    tarballs: pack(root, 'second'),
  });
  assert.notEqual(first.core.contentSha256, second.core.contentSha256);
});

test('source-derived packed content audit rejects missing, extra and duplicated members', async (t) => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'package/extra.txt'), 'unexpected');
  for (const [label, selected, pattern] of [
    ['missing', members.slice(1), /do not exactly match source modules/u],
    [
      'extra',
      [...members, 'package/extra.txt'],
      /do not exactly match source modules/u,
    ],
    ['duplicate', [...members, members[0]], /duplicate entries/u],
  ]) {
    await assert.rejects(
      auditPackedContent({
        repositoryRoot: root,
        tarballs: pack(root, label, selected),
      }),
      pattern,
    );
  }
});
