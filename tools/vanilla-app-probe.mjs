import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  packGattLabTarballs,
  runChecked,
  runCommand,
} from './package-tarball-harness.mjs';
import {
  assertServerProcessesExited,
  cleanupServerProcesses,
  inspectFailureReport,
} from './vanilla-probe-checks.mjs';
import { prepareVanillaConsumer } from './installed-consumers.mjs';

const repositoryRoot = process.cwd();
const probeRoot = await realpath(
  await mkdtemp(join(tmpdir(), 'gattlab-vanilla-probe-')),
);
const consumerRoot = resolve(probeRoot, 'consumer');

try {
  const tarballRoot = resolve(probeRoot, 'tarballs');
  await mkdir(tarballRoot);
  await mkdir(consumerRoot);

  const tarballs = await packGattLabTarballs({
    repositoryRoot,
    tarballRoot,
  });
  const { compilerVersions } = await prepareVanillaConsumer({
    repositoryRoot,
    consumerRoot,
    tarballs,
  });

  const repeatedOutput = runChecked(
    'Vanilla application repeated scenarios',
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      'tests/vanilla-app.spec.ts',
      '--config=playwright.config.ts',
      '--repeat-each=3',
      '--workers=1',
      '--reporter=line',
    ],
    consumerRoot,
  );
  await assertServerProcessesExited(consumerRoot, 3);
  assert.match(
    repeatedOutput,
    /\b36 passed\b/u,
    'The twelve passing cases must complete three sequential repetitions.',
  );

  const regressionOutput = runChecked(
    'Vanilla application regression scenarios',
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      'tests/vanilla-regression.spec.ts',
      '--config=playwright.config.ts',
      '--repeat-each=1',
      '--workers=1',
      '--reporter=line',
    ],
    consumerRoot,
  );
  await assertServerProcessesExited(consumerRoot, 4);
  assert.match(
    regressionOutput,
    /\b6 passed\b/u,
    'All six regression scenarios must complete once after the main scenarios.',
  );

  const failingResult = runCommand(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      'tests/artifact-failure.spec.ts',
      '--config=playwright.config.ts',
      '--workers=1',
      '--reporter=json',
    ],
    consumerRoot,
  );
  await assertServerProcessesExited(consumerRoot, 5);
  if (failingResult.error !== undefined) {
    throw new Error(
      `Intentional artifact scenario could not start: ${failingResult.error.message}`,
      { cause: failingResult.error },
    );
  }
  assert.equal(
    failingResult.status,
    1,
    `Intentional artifact scenario must fail with exit 1.\n${failingResult.stdout}${failingResult.stderr}`,
  );
  const report = JSON.parse(failingResult.stdout);
  await inspectFailureReport(
    report,
    consumerRoot,
    'intentional-vanilla-mismatch',
  );

  console.log(
    `Vanilla TypeScript sample probe passed: strict sample and installed scenario and regression checks on TypeScript ${compilerVersions.join(' + ')}, isolated tarball install, 12 scenarios x 3 runs (36 passed) and 6 regression tests (6 passed) in real Chromium, and 1 expected assertion failure with 4 inspected redacted artifacts; all 5 registered sample servers exited.`,
  );
} finally {
  try {
    await cleanupServerProcesses(consumerRoot);
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}
