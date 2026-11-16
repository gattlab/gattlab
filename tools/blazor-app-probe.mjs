import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packGattLabTarballs, runCommand } from './package-tarball-harness.mjs';
import {
  assertServerProcessesExited,
  cleanupServerProcesses,
  inspectFailureReport,
} from './vanilla-probe-checks.mjs';
import {
  assertBlazorReport,
  blazorScenarioCases,
  blazorSmokeCases,
} from './blazor-probe-checks.mjs';
import { prepareBlazorConsumer } from './installed-consumers.mjs';

const repositoryRoot = process.cwd();
const probeRoot = await realpath(
  await mkdtemp(join(tmpdir(), 'gattlab-blazor-probe-')),
);
const consumerRoot = resolve(probeRoot, 'consumer');
let primaryError;
try {
  const tarballRoot = resolve(probeRoot, 'tarballs');
  await mkdir(tarballRoot);
  await mkdir(consumerRoot);
  const tarballs = await packGattLabTarballs({ repositoryRoot, tarballRoot });
  await prepareBlazorConsumer({ repositoryRoot, consumerRoot, tarballs });
  const smoke = runBlazorSuite(
    'tests/blazor-app.spec.ts',
    'Blazor B1–B3 real Chromium smoke',
  );
  assertBlazorReport(smoke, blazorSmokeCases);
  await assertServerProcessesExited(consumerRoot, 1);
  const scenarios = runBlazorSuite(
    'tests/blazor-scenarios.spec.ts',
    'Blazor E1–E5/L1–L3 scenario suite',
  );
  assertBlazorReport(scenarios, blazorScenarioCases);
  await assertServerProcessesExited(consumerRoot, 2);

  const failing = runCommand(
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
  await assertServerProcessesExited(consumerRoot, 3);
  if (failing.error)
    throw new Error('Blazor artifact scenario could not start', {
      cause: failing.error,
    });
  assert.equal(
    failing.status,
    1,
    `Intentional Blazor artifact scenario must fail with exit 1.\n${failing.stdout}${failing.stderr}`,
  );
  await inspectFailureReport(
    JSON.parse(failing.stdout),
    consumerRoot,
    'intentional-blazor-mismatch',
  );
  console.log(
    `Blazor probe passed: smoke 3/3 and scenarios 9/9 real Chromium tests once (scenario run ${(scenarios.stats.duration / 1000).toFixed(1)} s), 1 expected Razor assertion failure with 4 inspected redacted artifacts, TS 6.0.3 + 5.9.3 strict coverage of all installed tests, configuration and support, three isolated tarballs, published/live profile parity, 3 registered servers exited.`,
  );
} catch (error) {
  primaryError = error;
} finally {
  try {
    await cleanupServerProcesses(consumerRoot);
  } catch (error) {
    if (primaryError)
      console.error('Secondary Blazor server cleanup failure:', error);
    else primaryError = error;
  } finally {
    try {
      await rm(probeRoot, { recursive: true, force: true });
    } catch (error) {
      if (primaryError)
        console.error('Secondary Blazor directory cleanup failure:', error);
      else primaryError = error;
    }
  }
}
if (primaryError) throw primaryError;

function runBlazorSuite(spec, label) {
  const result = runCommand(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      spec,
      '--config=playwright.config.ts',
      '--repeat-each=1',
      '--workers=1',
      '--reporter=json',
    ],
    consumerRoot,
  );
  if (result.error)
    throw new Error(`${label} could not start`, { cause: result.error });
  const report = JSON.parse(result.stdout);
  if (result.status !== 0) {
    // Keep the original test failure, not the JSON reporter's base64 attachments.
    const failures = [];
    function collect(suite) {
      for (const child of suite.specs ?? []) {
        for (const test of child.tests ?? []) {
          for (const run of test.results ?? []) {
            if (run.status !== 'passed')
              failures.push(
                `${child.title}: ${run.status}\n${run.error?.message ?? ''}`,
              );
          }
        }
      }
      for (const child of suite.suites ?? []) collect(child);
    }
    for (const suite of report.suites ?? []) collect(suite);
    throw new Error(
      `${label} failed with exit ${String(result.status)}:\n${failures.join('\n')}\n${JSON.stringify(report.errors)}\n${result.stderr}`,
    );
  }
  return report;
}
