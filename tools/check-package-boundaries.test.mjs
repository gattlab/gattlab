import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const checker = fileURLToPath(
  new URL('./check-package-boundaries.mjs', import.meta.url),
);
const forbiddenImports = fileURLToPath(
  new URL('./package-boundary-fixtures/forbidden-imports.ts', import.meta.url),
);
const browserFixture = fileURLToPath(
  new URL('./package-boundary-fixtures/tsconfig.json', import.meta.url),
);
const forbiddenProtocolRoot = fileURLToPath(
  new URL(
    './package-boundary-fixtures/raw-protocol-forbidden/packages',
    import.meta.url,
  ),
);
const allowedProtocolRoot = fileURLToPath(
  new URL(
    './package-boundary-fixtures/raw-protocol-allowed/packages',
    import.meta.url,
  ),
);
const allowedProtocolCoreFile = fileURLToPath(
  new URL(
    './package-boundary-fixtures/raw-protocol-allowed/packages/cdp/src/allowed.ts',
    import.meta.url,
  ),
);
const tsc = require.resolve('typescript/bin/tsc');

const forbiddenImportResult = spawnSync(
  process.execPath,
  [checker, forbiddenImports],
  { cwd: repositoryRoot, encoding: 'utf8' },
);

assert.equal(forbiddenImportResult.status, 1);
assert.match(forbiddenImportResult.stderr, /cannot import Playwright/);
assert.match(
  forbiddenImportResult.stderr,
  /cannot import Chrome DevTools Protocol/,
);
assert.match(forbiddenImportResult.stderr, /cannot import Node filesystem/);

const forbiddenProtocolResult = spawnSync(
  process.execPath,
  [checker, allowedProtocolCoreFile, forbiddenProtocolRoot],
  { cwd: repositoryRoot, encoding: 'utf8' },
);

assert.equal(forbiddenProtocolResult.status, 1);
assert.match(
  forbiddenProtocolResult.stderr,
  /raw CDP protocol name "BluetoothEmulation\.enable" is only allowed/,
);
assert.match(
  forbiddenProtocolResult.stderr,
  /raw CDP protocol name "DeviceAccess\.deviceRequestPrompted" is only allowed/,
);
assert.doesNotMatch(forbiddenProtocolResult.stderr, /cdp\/src\/allowed\.ts/);

const allowedProtocolResult = spawnSync(
  process.execPath,
  [checker, allowedProtocolCoreFile, allowedProtocolRoot],
  { cwd: repositoryRoot, encoding: 'utf8' },
);

assert.equal(allowedProtocolResult.status, 0);
assert.doesNotMatch(allowedProtocolResult.stderr, /raw CDP protocol name/);

const browserGlobalResult = spawnSync(
  process.execPath,
  [tsc, '--project', browserFixture, '--pretty', 'false'],
  { cwd: repositoryRoot, encoding: 'utf8' },
);

assert.equal(browserGlobalResult.status, 2);
assert.match(browserGlobalResult.stdout, /Cannot find name 'navigator'/);

console.log(
  'Negative boundary checks passed: core rejects Playwright, CDP, ' +
    'Node filesystem, and browser globals; raw protocol names stay in cdp.',
);
