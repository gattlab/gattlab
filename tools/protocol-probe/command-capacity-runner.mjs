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
import {
  packGattLabTarballs,
  runCommand,
} from '../package-tarball-harness.mjs';
import { prepareVanillaConsumer } from '../installed-consumers.mjs';
import {
  assertServerProcessesExited,
  cleanupServerProcesses,
} from '../vanilla-probe-checks.mjs';
import { commandCapacityInventory } from './command-capacity-inventory.mjs';
import {
  assertCommandCapacity,
  assertNativeCommandCounts,
  commandTimingDiagnostics,
} from './command-capacity-checks.mjs';

const repositoryRoot = process.cwd();
const startedAt = new Date().toISOString();
const output = resolve(
  repositoryRoot,
  process.env.GATTLAB_CAPACITY_OUTPUT ??
    `test-results/command-capacity/${startedAt.replace(/[:.]/gu, '-')}`,
);
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), 'gattlab-command-capacity-')),
);
const consumerRoot = resolve(temporary, 'consumer');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
  cwd: repositoryRoot,
}).trim();
const clean =
  execFileSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
    cwd: repositoryRoot,
  }).trim() === '';
const inventory = await commandCapacityInventory(repositoryRoot);
const inventoryRecord = {
  ...inventory,
  profiles: inventory.profiles.map(
    ({ definition: _definition, ...metadata }) => metadata,
  ),
};
await mkdir(resolve(output, '..'), { recursive: true });
await mkdir(output);
let summary = {
  schemaVersion: 1,
  status: 'failed',
  startedAt,
  sourceSha,
  clean,
  venue: process.env.GITHUB_ACTIONS === 'true' ? 'ordinary-ci' : 'local-host',
  environment: {
    platform: platform(),
    arch: arch(),
    kernel: release(),
    node: process.version,
    pnpm: execFileSync('pnpm', ['--version'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim(),
    ...(platform() === 'linux'
      ? { osRelease: await readFile('/etc/os-release', 'utf8') }
      : {}),
  },
  ...(process.env.GITHUB_RUN_ID
    ? { ci: { runId: process.env.GITHUB_RUN_ID, job: process.env.GITHUB_JOB } }
    : {}),
  inventory: inventoryRecord,
  observations: [],
};
try {
  await mkdir(resolve(temporary, 'tarballs'));
  await mkdir(consumerRoot);
  const tarballs = await packGattLabTarballs({
    repositoryRoot,
    tarballRoot: resolve(temporary, 'tarballs'),
  });
  const fixtureSource = resolve(temporary, 'capacity-profiles.ts');
  await writeFile(
    fixtureSource,
    `export const profiles = ${JSON.stringify(inventory.profiles, null, 2)} as const;\n`,
  );
  const prepared = await prepareVanillaConsumer({
    repositoryRoot,
    consumerRoot,
    tarballs,
    additionalFixtures: [
      {
        source: resolve(
          repositoryRoot,
          'tools/protocol-probe/command-capacity.spec.ts',
        ),
        destination: 'tests/command-capacity.spec.ts',
      },
      { source: fixtureSource, destination: 'tests/capacity-profiles.ts' },
      {
        source: resolve(
          repositoryRoot,
          'tools/protocol-probe/command-budget-types.ts',
        ),
        destination: 'tests/command-budget-types.ts',
      },
    ],
  });
  const result = runCommand(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      'tests/command-capacity.spec.ts',
      '--config=playwright.config.ts',
      '--workers=1',
      '--reporter=json',
    ],
    consumerRoot,
  );
  await writeFile(resolve(output, 'stdout.log'), result.stdout);
  await writeFile(resolve(output, 'stderr.log'), result.stderr);
  if (result.error) throw result.error;
  const report = JSON.parse(result.stdout);
  const results = [];
  const visit = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests) {
        assert.equal(
          test.results.length,
          1,
          'Capacity requires one attempt and no retries',
        );
        results.push(test.results[0]);
      }
    for (const nested of suite.suites ?? []) visit(nested);
  };
  for (const suite of report.suites) visit(suite);
  for (const result of results) {
    const attachment = result.attachments?.find(
      ({ name }) => name === 'command-capacity.json',
    );
    if (!attachment) continue;
    let body;
    if (attachment.path) {
      const path = resolve(attachment.path);
      assert.ok(
        !relative(consumerRoot, path).startsWith('..'),
        'Capacity attachment must belong to the consumer',
      );
      body = await readFile(path, 'utf8');
    } else {
      assert.equal(typeof attachment.body, 'string');
      body = Buffer.from(attachment.body, 'base64').toString('utf8');
    }
    const row = JSON.parse(body);
    summary.observations.push(row);
  }
  summary.compilerVersions = prepared.compilerVersions;
  const registeredServers = (
    await readFile(resolve(consumerRoot, 'server-pids.jsonl'), 'utf8')
  )
    .trim()
    .split(/\r?\n/u).length;
  summary.cleanup = { registeredServers, allExited: false };
  await assertServerProcessesExited(consumerRoot, registeredServers);
  summary.cleanup.allExited = true;
  assert.equal(
    result.status,
    0,
    'Command capacity browser cases must pass (original failed logs retained)',
  );
  assert.equal(
    registeredServers,
    1,
    'Passing capacity tests must share one server and have no worker restart',
  );
  assert.equal(results.length, inventory.profiles.length * 2);
  assert.ok(results.every(({ status }) => status === 'passed'));
  summary.status = 'passed';
  Object.assign(summary, assertCommandCapacity(summary, inventory.profiles));
  summary.commandCounts = assertNativeCommandCounts(
    summary,
    inventory.profiles,
  );
  const baseline = JSON.parse(
    await readFile(
      resolve(
        repositoryRoot,
        'tools/protocol-probe/command-capacity-baseline.json',
      ),
      'utf8',
    ),
  );
  summary.timingDiagnostics = commandTimingDiagnostics(summary, baseline);
} catch (error) {
  summary.status = 'failed';
  await writeFile(
    resolve(output, 'failure.log'),
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  summary.failure = {
    name: error instanceof Error ? error.name : 'Unknown failure',
    message:
      'Capacity preparation or browser verification failed; original private failure.log retained.',
  };
  process.exitCode = 1;
} finally {
  try {
    await cleanupServerProcesses(consumerRoot);
  } finally {
    summary.finishedAt = new Date().toISOString();
    await writeFile(
      resolve(output, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    const bytes = await readFile(resolve(output, 'summary.json'));
    console.log(
      JSON.stringify({
        commandCapacity: summary.status,
        sourceSha,
        clean,
        profiles: inventory.profiles.length,
        samples: summary.sampleCount,
        maximumMs: summary.maximumMs,
        commandCounts: summary.commandCounts,
        timingDiagnostics: summary.timingDiagnostics,
        summarySha256: createHash('sha256').update(bytes).digest('hex'),
        output: relative(repositoryRoot, output),
      }),
    );
    await rm(temporary, { recursive: true, force: true });
  }
}
