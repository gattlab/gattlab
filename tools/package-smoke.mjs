import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertCleanGattLabInstall,
  gattLabTarballDependencies,
  offlineConsumerInstallArguments,
  packGattLabTarballs,
  repositoryDevDependency,
  runChecked,
  writeGattLabTarballOverrides,
} from './package-tarball-harness.mjs';
import {
  auditPackedContent,
  assertPublicationManifest,
} from './package-content-checks.mjs';

const require = createRequire(import.meta.url);
const repositoryRoot = process.cwd();
const rootManifest = JSON.parse(
  await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
);
const packageVersion = rootManifest.version;
assert.equal(rootManifest.private, true);
assert.equal(typeof packageVersion, 'string');
const supportedPlaywrightRange = '>=1.65.0 <2.0.0';
const repositoryCompiler = require.resolve('typescript/bin/tsc');
const oldestConsumerCompiler = require.resolve('typescript-5-9/bin/tsc');
const consumerCompilers = [
  {
    executable: repositoryCompiler,
    label: 'TypeScript 6.0.3',
    version: 'Version 6.0.3',
  },
  {
    executable: oldestConsumerCompiler,
    label: 'TypeScript 5.9.3',
    version: 'Version 5.9.3',
  },
];

const coreRuntimeExports = [
  'BackendLifecycleController',
  'BluetoothBackendStoppedError',
  'BluetoothCancelledError',
  'BluetoothCapabilityUnsupportedError',
  'BluetoothConcurrentOperationError',
  'BluetoothLabAlreadyActiveError',
  'BluetoothPeripheralAlreadyRegisteredError',
  'BluetoothTimeoutError',
  'BluetoothValidationError',
  'GattLabError',
  'PeripheralAddressRegistry',
  'PromptDeviceNotFoundError',
  'attErrorNames',
  'bytes',
  'centralStates',
  'characteristicProperties',
  'copyBackendBluetoothEvent',
  'createBluetoothTimeline',
  'createCancellationController',
  'gattLabErrorCodes',
  'hciErrorNames',
  'normalizeBluetoothAddress',
  'normalizeBluetoothUuid',
  'runBestEffortBackendCleanup',
  'snapshotBluetoothCapabilities',
  'timelineCategories',
  'timelineStatuses',
  'validatePeripheralDefinition',
].sort();

const cdpRuntimeExports = [
  'CdpBluetoothBackendFactory',
  'CdpCapabilityProbe',
  'CdpTransport',
  'CdpTransportError',
  'attErrorCode',
  'attErrorCodes',
  'createCdpTransport',
  'hciErrorCode',
  'hciErrorCodes',
  'protocolSuccessCode',
].sort();

const packages = {
  core: {
    dependencies: {},
    packedDependencies: {},
    references: [],
    runtimeExports: coreRuntimeExports,
  },
  cdp: {
    dependencies: {
      '@gattlab/core': 'workspace:*',
      'devtools-protocol': '0.0.1674729',
    },
    packedDependencies: {
      '@gattlab/core': packageVersion,
      'devtools-protocol': '0.0.1674729',
    },
    references: ['../core'],
    runtimeExports: cdpRuntimeExports,
  },
  playwright: {
    dependencies: {
      '@gattlab/cdp': 'workspace:*',
      '@gattlab/core': 'workspace:*',
    },
    packedDependencies: {
      '@gattlab/cdp': packageVersion,
      '@gattlab/core': packageVersion,
    },
    peerDependencies: {
      '@playwright/test': supportedPlaywrightRange,
    },
    references: ['../core', '../cdp'],
    runtimeExports: ['BluetoothLab', 'bytes', 'expect', 'test'].sort(),
  },
};

for (const [directory, expected] of Object.entries(packages)) {
  const packageRoot = resolve('packages', directory);
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
  );
  const tsconfig = JSON.parse(
    await readFile(resolve(packageRoot, 'tsconfig.json'), 'utf8'),
  );

  assertPublicationManifest(manifest, directory, packageVersion);
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.dependencies ?? {}, expected.dependencies);
  assert.deepEqual(
    manifest.peerDependencies ?? {},
    expected.peerDependencies ?? {},
  );
  assert.deepEqual(
    (tsconfig.references ?? []).map((reference) => reference.path),
    expected.references,
  );

  const packageExport = manifest.exports['.'];
  assert.equal(packageExport.types, './dist/index.d.ts');
  assert.equal(packageExport.import, './dist/index.js');
  assert.equal(packageExport.default, './dist/index.js');

  await Promise.all(
    [
      packageExport.types,
      `${packageExport.types}.map`,
      packageExport.import,
      `${packageExport.import}.map`,
    ].map((target) => access(resolve(packageRoot, target))),
  );
  const loadedPackage = await import(
    pathToFileURL(resolve(packageRoot, packageExport.import)).href
  );
  assert.deepEqual(Object.keys(loadedPackage).sort(), expected.runtimeExports);
}

assert.notEqual(
  await realpath(repositoryCompiler),
  await realpath(oldestConsumerCompiler),
  'Consumer compiler checks must resolve distinct TypeScript installations.',
);

const smokeRoot = await mkdtemp(join(tmpdir(), 'gattlab-package-smoke-'));
try {
  const tarballRoot = resolve(smokeRoot, 'tarballs');
  await mkdir(tarballRoot);
  const tarballs = await packGattLabTarballs({
    repositoryRoot,
    tarballRoot,
  });
  await auditPackedContent({ repositoryRoot, tarballs });

  for (const [directory, expected] of Object.entries(packages)) {
    const tarball = tarballs[directory];

    const packedManifest = JSON.parse(
      runChecked(
        `${directory} packed manifest`,
        'tar',
        ['-xOf', tarball, 'package/package.json'],
        repositoryRoot,
      ),
    );
    assert.deepEqual(
      packedManifest.dependencies ?? {},
      expected.packedDependencies,
    );
    assertPublicationManifest(packedManifest, directory, packageVersion);
    assert.deepEqual(
      packedManifest.peerDependencies ?? {},
      expected.peerDependencies ?? {},
    );
    assert.equal(
      JSON.stringify(packedManifest).includes('workspace:'),
      false,
      `${directory} packed manifest contains a workspace protocol.`,
    );

    runChecked(
      `${directory} publint`,
      'pnpm',
      ['exec', 'publint', tarball, '--strict', '--pack=false'],
      repositoryRoot,
    );
    runChecked(
      `${directory} arethetypeswrong`,
      'pnpm',
      ['exec', 'attw', tarball, '--profile', 'esm-only', '--format', 'ascii'],
      repositoryRoot,
    );
  }

  const consumerRoot = resolve(smokeRoot, 'consumer');
  await mkdir(consumerRoot);
  await writeConsumerProject(consumerRoot, tarballs);
  runChecked(
    'clean consumer install',
    'pnpm',
    offlineConsumerInstallArguments(consumerRoot, repositoryRoot),
    repositoryRoot,
  );

  await assertCleanGattLabInstall({ consumerRoot, repositoryRoot });

  runChecked(
    'installed runtime exports',
    process.execPath,
    ['runtime-consumer.mjs'],
    consumerRoot,
  );
  let compilerRuns = 0;
  for (const compiler of consumerCompilers) {
    assert.equal(
      runChecked(
        `${compiler.label} version`,
        process.execPath,
        [compiler.executable, '--version'],
        consumerRoot,
      ),
      compiler.version,
    );
    runChecked(
      `consumer declarations with ${compiler.label}`,
      process.execPath,
      [compiler.executable, '--project', 'tsconfig.json'],
      consumerRoot,
    );
    compilerRuns += 1;
  }
  assert.equal(
    compilerRuns,
    2,
    'The clean consumer must be compiled by both pinned TypeScript versions.',
  );
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}

console.log(
  'Package smoke passed: 3 tarballs, content audits, publint/ATTW, clean install, runtime exports, and TypeScript 6.0.3 + 5.9.3 consumers.',
);

async function writeConsumerProject(consumerRoot, tarballs) {
  const { packageManager } = JSON.parse(
    await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.equal(packageManager, 'pnpm@12.11.2');
  const dependencies = {
    ...gattLabTarballDependencies(tarballs),
    '@playwright/test': '1.65.1',
    '@types/node': await repositoryDevDependency(repositoryRoot, '@types/node'),
  };
  await writeFile(
    resolve(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'gattlab-clean-consumer',
        private: true,
        type: 'module',
        packageManager,
        dependencies,
      },
      undefined,
      2,
    )}\n`,
  );
  await writeGattLabTarballOverrides(consumerRoot, tarballs);
  await writeFile(
    resolve(consumerRoot, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          lib: ['ES2023', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2023',
          types: ['node'],
          verbatimModuleSyntax: true,
        },
        include: ['core-consumer.ts', 'playwright-consumer.ts'],
      },
      undefined,
      2,
    )}\n`,
  );
  for (const fixture of [
    'core-consumer.ts',
    'playwright-consumer.ts',
    'runtime-consumer.mjs',
  ]) {
    await writeFile(
      resolve(consumerRoot, fixture),
      await readFile(
        resolve('tools', 'package-smoke-fixtures', fixture),
        'utf8',
      ),
    );
  }
}
