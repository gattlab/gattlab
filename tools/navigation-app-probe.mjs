import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { packGattLabTarballs, runCommand } from './package-tarball-harness.mjs';
import { prepareVanillaConsumer } from './installed-consumers.mjs';
import {
  assertServerProcessesExited,
  cleanupServerProcesses,
} from './vanilla-probe-checks.mjs';
import { commandCapacityInventory } from './protocol-probe/command-capacity-inventory.mjs';
import { PUBLIC_NAVIGATION_CASES } from './protocol-probe/navigation-public-manifest.mjs';
import {
  assertPublicNavigation,
  shortModelTimingDiagnostics,
  assertExpectedCleanupFailure,
  failedTestDiagnostic,
  assertPublicConsumerSource,
} from './protocol-probe/navigation-checks.mjs';

const root = process.cwd();
const startedAt = new Date().toISOString();
const output = resolve(
  root,
  process.env.GATTLAB_NAVIGATION_OUTPUT ??
    `test-results/public-navigation/${startedAt.replace(/[:.]/gu, '-')}`,
);
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), 'gattlab-public-navigation-')),
);
const consumerRoot = resolve(temporary, 'consumer');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const selected = process.env.GATTLAB_NAVIGATION_CASE
  ? PUBLIC_NAVIGATION_CASES.filter(
      (row) => row.id === process.env.GATTLAB_NAVIGATION_CASE,
    )
  : PUBLIC_NAVIGATION_CASES;
assert.ok(selected.length > 0, 'Unknown installed navigation case');
await mkdir(resolve(output, '..'), { recursive: true });
await mkdir(output);
const summary = {
  schemaVersion: 1,
  status: 'failed',
  verificationStage: 'preparation',
  startedAt,
  sourceSha,
  clean:
    execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    }).trim() === '',
  venue: process.env.GITHUB_ACTIONS === 'true' ? 'ordinary-ci' : 'local-host',
  environment: {
    platform: platform(),
    arch: arch(),
    kernel: release(),
    node: process.version,
  },
  invocations: [],
  results: [],
  cleanup: { registeredServers: 0, allExited: false },
};
try {
  assertPublicConsumerSource(
    await readFile(
      resolve(root, 'tools/protocol-probe/navigation.spec.ts'),
      'utf8',
    ),
  );
  await mkdir(resolve(temporary, 'tarballs'));
  await mkdir(consumerRoot);
  const tarballs = await packGattLabTarballs({
    repositoryRoot: root,
    tarballRoot: resolve(temporary, 'tarballs'),
  });
  const casesSource = resolve(temporary, 'navigation-cases.ts');
  const inventory = await commandCapacityInventory(root);
  summary.capacityProfileIds = inventory.profiles.map((profile) => profile.id);
  const profilesSource = resolve(temporary, 'capacity-profiles.ts');
  await writeFile(
    profilesSource,
    `export const profiles = ${JSON.stringify(inventory.profiles, null, 2)} as const;\n`,
  );
  await writeFile(
    casesSource,
    `export interface Scenario { id: string; testIds: readonly string[]; group: string; level: string; action: string; subject: string; repair?: string; expectedCleanupFailure?: boolean; retainedFixture?: boolean; state?: 'absent'|'powered-off'|'powered-on' }\nexport const scenarios: readonly Scenario[] = ${JSON.stringify(PUBLIC_NAVIGATION_CASES, null, 2)};\n`,
  );
  const prepared = await prepareVanillaConsumer({
    repositoryRoot: root,
    consumerRoot,
    tarballs,
    additionalFixtures: [
      {
        source: resolve(root, 'tools/protocol-probe/public-close-sequence.mjs'),
        destination: 'tests/public-close-sequence.mjs',
      },
      {
        source: resolve(
          root,
          'tools/protocol-probe/public-close-sequence.d.mts',
        ),
        destination: 'tests/public-close-sequence.d.mts',
      },
      {
        source: resolve(root, 'tools/protocol-probe/navigation.spec.ts'),
        destination: 'tests/navigation.spec.ts',
      },
      { source: casesSource, destination: 'tests/navigation-cases.ts' },
      { source: profilesSource, destination: 'tests/capacity-profiles.ts' },
    ],
  });
  summary.compilerVersions = prepared.compilerVersions;
  summary.verificationStage = 'cases';
  for (const scenario of selected) {
    const directory = resolve(
      output,
      scenario.id.replace(/[^a-zA-Z0-9.-]/gu, '_'),
    );
    await mkdir(directory);
    const before = summary.cleanup.registeredServers;
    const expression = scenario.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    // A fresh Playwright invocation gives every scenario a fresh browser process.
    // Only N10 keeps two sequential fixture owners inside this one invocation.
    const result = runCommand(
      'pnpm',
      [
        'exec',
        'playwright',
        'test',
        'tests/navigation.spec.ts',
        '--config=playwright.config.ts',
        '--workers=1',
        '--retries=0',
        `--grep=${expression}(?:$|:)`,
        '--reporter=json',
      ],
      consumerRoot,
    );
    await writeFile(resolve(directory, 'stdout.json'), result.stdout);
    await writeFile(resolve(directory, 'stderr.log'), result.stderr);
    const invocation = {
      id: scenario.id,
      status: 'failed',
      freshProcess: true,
      caseIds: [],
      reportSha256: createHash('sha256').update(result.stdout).digest('hex'),
      cleanup: { registeredServers: 0, allExited: false },
    };
    summary.invocations.push(invocation);
    try {
      if (result.error) throw result.error;
      const report = JSON.parse(result.stdout);
      const tests = [];
      const visit = (suite) => {
        for (const spec of suite.specs ?? [])
          for (const test of spec.tests)
            tests.push({ title: spec.title, ...test });
        for (const child of suite.suites ?? []) visit(child);
      };
      for (const suite of report.suites) visit(suite);
      assert.equal(tests.length, scenario.testIds.length);
      for (const test of tests) {
        assert.equal(
          test.results.length,
          1,
          'Installed navigation requires one attempt',
        );
        const observed = test.results[0];
        const attachment = observed.attachments?.find(
          ({ name }) => name === 'navigation-public.json',
        );
        let row;
        if (attachment?.body)
          row = JSON.parse(
            Buffer.from(attachment.body, 'base64').toString('utf8'),
          );
        else if (attachment?.path) {
          const path = resolve(attachment.path);
          assert.ok(!relative(consumerRoot, path).startsWith('..'));
          row = JSON.parse(await readFile(path, 'utf8'));
        }
        const caseId = row?.caseId ?? test.title;
        const expectedCleanup = scenario.expectedCleanupFailure === true;
        let cleanupFailureVerified = false;
        if (expectedCleanup) {
          cleanupFailureVerified = assertExpectedCleanupFailure(
            test,
            observed,
            row,
          );
        }
        invocation.caseIds.push(caseId);
        summary.results.push({
          caseId,
          status: cleanupFailureVerified
            ? 'expected-cleanup-failure'
            : observed.status,
          cleanupFailureVerified,
          attempts: test.results.length,
          browserVersion: row?.browserVersion,
          observations: row?.observations,
          ...(observed.status !== 'passed' && !expectedCleanup
            ? { failure: failedTestDiagnostic(observed, test.annotations) }
            : {}),
        });
        if (!expectedCleanup) assert.equal(observed.status, 'passed');
      }
      assert.equal(result.status, 0, 'Original failed case report retained');
      assert.ok(
        tests.every(
          (test) =>
            test.results[0].status ===
            (scenario.expectedCleanupFailure ? 'failed' : 'passed'),
        ),
      );
      assert.deepEqual(invocation.caseIds, scenario.testIds);
      invocation.status = 'passed';
    } catch (error) {
      await writeFile(
        resolve(directory, 'failure.log'),
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
    } finally {
      const pids = (
        await readFile(resolve(consumerRoot, 'server-pids.jsonl'), 'utf8')
      )
        .trim()
        .split(/\r?\n/gu)
        .filter(Boolean);
      summary.cleanup.registeredServers = pids.length;
      invocation.cleanup.registeredServers = pids.length - before;
      try {
        await assertServerProcessesExited(consumerRoot, pids.length);
        invocation.cleanup.allExited = true;
      } catch (error) {
        invocation.status = 'failed';
        await writeFile(
          resolve(directory, 'cleanup-failure.log'),
          String(error),
        );
      }
      await cleanupServerProcesses(consumerRoot);
    }
    console.log(
      JSON.stringify({ case: scenario.id, status: invocation.status }),
    );
  }
  summary.cleanup.allExited = summary.invocations.every(
    (row) => row.cleanup.allExited,
  );
  summary.status = 'passed';
  summary.verificationStage = 'coverage';
  Object.assign(summary, assertPublicNavigation(summary));
  const baseline = JSON.parse(
    await readFile(
      resolve(root, 'tools/protocol-probe/command-capacity-baseline.json'),
      'utf8',
    ),
  );
  summary.verificationStage = 'timing-diagnostics';
  summary.timingDiagnostics = shortModelTimingDiagnostics(summary, baseline);
  summary.verificationStage = 'complete';
} catch (error) {
  summary.status = 'failed';
  await writeFile(
    resolve(output, 'failure.log'),
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  summary.failure = {
    name: error instanceof Error ? error.name : 'Unknown failure',
    message:
      'Installed navigation verification failed; full reports are kept in test-results/.',
  };
  process.exitCode = 1;
} finally {
  try {
    await cleanupServerProcesses(consumerRoot);
  } finally {
    summary.finishedAt = new Date().toISOString();
    const body = `${JSON.stringify(summary, null, 2)}\n`;
    await writeFile(resolve(output, 'summary.json'), body);
    console.log(
      JSON.stringify({
        publicNavigation: summary.status,
        cases: summary.results.length,
        terminalOutcomes: summary.terminalOutcomes,
        sourceSha,
        verificationStage: summary.verificationStage,
        timingDiagnostics: summary.timingDiagnostics,
        summarySha256: createHash('sha256').update(body).digest('hex'),
        output: relative(root, output),
      }),
    );
    await rm(temporary, { recursive: true, force: true });
  }
}
