import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  packGattLabTarballs,
  runCommand,
  runChecked,
} from './package-tarball-harness.mjs';
import { prepareReactConsumer } from './react-consumer.mjs';
import {
  assertReactDevelopmentRuntime,
  assertReactReport,
  reactDevelopmentMarker,
} from './react-probe-checks.mjs';
import {
  assertServerProcessesExited,
  cleanupServerProcesses,
  inspectFailureReport,
} from './vanilla-probe-checks.mjs';
import { buildReactBundle } from './react-build.mjs';

const repositoryRoot = process.cwd();
const evidenceBase = resolve(repositoryRoot, 'test-results/react-probe');
await mkdir(evidenceBase, { recursive: true });
const evidenceRoot = await mkdtemp(join(evidenceBase, 'run-'));
const probeRoot = await realpath(
  await mkdtemp(join(tmpdir(), 'gattlab-react-probe-')),
);
const consumerRoot = resolve(probeRoot, 'consumer');
let primaryError;
try {
  const tarballRoot = resolve(probeRoot, 'tarballs');
  await mkdir(tarballRoot);
  const tarballs = await packGattLabTarballs({ repositoryRoot, tarballRoot });
  const prepared = await prepareReactConsumer({
    repositoryRoot,
    consumerRoot,
    tarballs,
  });

  // A directory called development and Vite mode alone are insufficient. Build
  // the real faulty application and require the actual runtime guard to fail.
  const negativeRoot = resolve(evidenceRoot, 'mode-only-development');
  await buildReactBundle({
    repositoryRoot,
    build: 'development',
    outputDirectory: negativeRoot,
    modeOnly: true,
  });
  let negativeFailure;
  try {
    await assertReactDevelopmentRuntime(negativeRoot);
  } catch (error) {
    negativeFailure = error;
  }
  assert.match(
    negativeFailure?.message ?? '',
    /development React runtime marker must be present/u,
    'The real mode-only negative bundle must fail the runtime guard.',
  );
  await writeFile(
    resolve(evidenceRoot, 'mode-only-negative.json'),
    `${JSON.stringify({ mode: 'development', NODE_ENV: 'absent in fresh child', error: negativeFailure.message, marker: reactDevelopmentMarker }, undefined, 2)}\n`,
  );

  const passing = await runSuite('tests/react-app.spec.ts', 'react-app');
  assert.equal(passing.result.status, 0, describeFailures(passing.report));
  assertReactReport(passing.report);
  await assertServerProcessesExited(consumerRoot, 2);

  const failing = await runSuite(
    'tests/artifact-failure.spec.ts',
    'artifact-failure',
  );
  assert.equal(
    failing.result.status,
    1,
    'Intentional React assertion must exit 1.',
  );
  await assertServerProcessesExited(consumerRoot, 3);
  await inspectFailureReport(
    failing.report,
    consumerRoot,
    'intentional-react-mismatch',
  );
  const summary = {
    sourceSha: runChecked(
      'React probe source SHA',
      'git',
      ['rev-parse', 'HEAD'],
      repositoryRoot,
    ),
    worktreeDirty:
      runChecked(
        'React probe worktree',
        'git',
        ['status', '--porcelain'],
        repositoryRoot,
      ) !== '',
    cases: 4,
    consumerCompilers: prepared.compilerVersions,
    runtimeMarker: {
      value: reactDevelopmentMarker,
      source: 'react-dom@19.3.1/cjs/react-dom-client.development.js',
    },
    assets: prepared.assets,
    modeOnlyNegative: 'rejected',
    intentionalFailure: 'inspected',
    serversExited: 3,
  };
  await writeFile(
    resolve(evidenceRoot, 'summary.json'),
    `${JSON.stringify(summary, undefined, 2)}\n`,
  );
  console.log(
    `React probe passed: R1–R4 4/4 once, one worker, no retries/skips, TS 6.0.3 + 5.9.3 full strict fixture coverage, three installed tarballs, live UUID/payload parity, production/development runtime identity, real mode-only negative rejected, intentional wrong-value failure with four inspected redacted artifacts, 3 registered servers exited. Evidence: ${evidenceRoot}`,
  );
} catch (error) {
  primaryError = error;
  console.error(`React probe evidence retained: ${evidenceRoot}`);
} finally {
  try {
    await retainConsumerEvidence();
  } catch (error) {
    if (primaryError)
      console.error('Secondary React evidence copy failure:', error);
    else primaryError = error;
  }
  try {
    await cleanupServerProcesses(consumerRoot);
  } catch (error) {
    if (primaryError)
      console.error('Secondary React server cleanup failure:', error);
    else primaryError = error;
  } finally {
    try {
      await rm(probeRoot, { recursive: true, force: true });
    } catch (error) {
      if (primaryError)
        console.error('Secondary React directory cleanup failure:', error);
      else primaryError = error;
    }
  }
}
if (primaryError) throw primaryError;

async function retainConsumerEvidence() {
  for (const name of ['test-results', 'server-pids.jsonl']) {
    try {
      await cp(resolve(consumerRoot, name), resolve(evidenceRoot, name), {
        recursive: true,
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function runSuite(spec, label) {
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
  // Save complete originals before any report or result check. Artifacts are
  // synthetic sample data and remain local under the ignored evidence tree.
  await Promise.all([
    writeFile(resolve(evidenceRoot, `${label}.json`), result.stdout ?? ''),
    writeFile(resolve(evidenceRoot, `${label}.stderr`), result.stderr ?? ''),
  ]);
  if (result.error)
    throw new Error(`React ${label} could not start`, { cause: result.error });
  return { result, report: JSON.parse(result.stdout) };
}

function describeFailures(report) {
  const failures = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          if (result.status !== 'passed')
            failures.push(
              `${spec.title}: ${result.status}\n${result.error?.message ?? ''}`,
            );
        }
      }
    }
    for (const nested of suite.suites ?? []) visit(nested);
  }
  for (const suite of report.suites ?? []) visit(suite);
  return `React R1–R4 must exit zero:\n${failures.join('\n')}\n${JSON.stringify(report.errors)}`;
}
