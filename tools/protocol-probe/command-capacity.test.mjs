import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { commandCapacityInventory } from './command-capacity-inventory.mjs';
import {
  assertCommandCapacity,
  assertNativeCommandCounts,
  commandTimingDiagnostics,
} from './command-capacity-checks.mjs';

function fixture() {
  const operations = [
    'createPreconnectedPeripheral',
    'disconnect',
    'simulateAdvertisement',
    'liveness-check',
    'setCentralState:absent',
    'setCentralState:powered-off',
    'setCentralState:powered-on',
    'select',
    'selectById',
    'cancel',
    'respondToGattOperation',
    'respondToCharacteristicOperation',
    'respondToDescriptorOperation',
  ];
  const profile = {
    id: 'max-profile',
    counts: { services: 1, characteristics: 3, descriptors: 2 },
  };
  return {
    status: 'passed',
    sourceSha: 'a'.repeat(40),
    clean: true,
    compilerVersions: ['6.0.3', '5.9.3'],
    cleanup: { registeredServers: 1, allExited: true },
    venue: 'local-host',
    environment: {
      platform: 'linux',
      node: 'v26.11.1',
      pnpm: '12.11.2',
      osRelease: 'ID=ubuntu\nVERSION_ID="26.04"\n',
    },
    inventory: { profiles: [profile] },
    observations: ['cdp', 'playwright'].map((mode) => ({
      profileId: profile.id,
      mode,
      browserVersion: '159.0.8154.6',
      observations: [
        mode === 'cdp' ? 'addPeripheral' : 'createPeripheral',
        ...operations,
      ].map((operation) => ({
        operation,
        status: 'succeeded',
        elapsedMs: 3,
        commandCount:
          mode === 'cdp' && operation === 'createPreconnectedPeripheral'
            ? 0
            : 1,
      })),
    })),
  };
}

test('capacity cannot pass missing profiles, operations, timing, commands, compiler or cleanup evidence', () => {
  const baseline = fixture();
  assert.deepEqual(
    assertCommandCapacity(baseline, baseline.inventory.profiles),
    { maximumMs: 3, sampleCount: 28 },
  );
  const mutations = [
    (x) => x.observations.pop(),
    (x) => x.observations[0].observations.pop(),
    (x) => (x.observations[0].observations[0].elapsedMs = NaN),
    (x) => (x.observations[0].observations[0].commandCount = 0),
    (x) => (x.observations[0].observations[0].status = 'failed'),
    (x) => x.compilerVersions.pop(),
    (x) => (x.cleanup.allExited = false),
    (x) => (x.observations[0].browserVersion = 'unverified'),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.throws(() =>
      assertCommandCapacity(changed, baseline.inventory.profiles),
    );
  }
});

test('normal-success command-count budgets reject extra sends at both installed boundaries', () => {
  const current = fixture();
  for (const row of current.observations)
    for (const sample of row.observations) {
      if (
        ['addPeripheral', 'createPeripheral', 'disconnect'].includes(
          sample.operation,
        ) ||
        (row.mode === 'playwright' &&
          sample.operation === 'createPreconnectedPeripheral')
      )
        sample.commandCount = 7;
      else if (['select', 'selectById', 'cancel'].includes(sample.operation))
        sample.commandCount = 2;
    }
  assert.equal(
    assertNativeCommandCounts(current, current.inventory.profiles).sampleCount,
    28,
  );
  for (const row of current.observations)
    for (const sample of row.observations) {
      const changed = structuredClone(current);
      changed.observations
        .find((entry) => entry.mode === row.mode)
        .observations.find((entry) => entry.operation === sample.operation)
        .commandCount++;
      assert.throws(
        () => assertNativeCommandCounts(changed, changed.inventory.profiles),
        /command-count budget/u,
      );
    }
  const unknown = structuredClone(current);
  unknown.observations[0].observations.push({
    operation: 'unknown-operation',
    status: 'succeeded',
    elapsedMs: 1,
    commandCount: 1,
  });
  assert.throws(
    () => assertNativeCommandCounts(unknown, unknown.inventory.profiles),
    /Unknown command-count operation/u,
  );
});

test('current timing overruns are diagnostic while malformed or failed evidence still rejects', () => {
  const current = fixture();
  current.observations[0].observations[0].elapsedMs = 500;
  const diagnostic = commandTimingDiagnostics(current, {
    performanceThresholdMs: 6,
    sourceSha: 'a'.repeat(40),
    inventory: current.inventory,
  });
  assert.equal(diagnostic.status, 'diagnostic-only');
  assert.equal(diagnostic.samplesOverHistoricalThreshold, 1);
  assert.equal(diagnostic.maximumMs, 500);
  current.observations[0].observations[0].status = 'failed';
  assert.throws(() =>
    commandTimingDiagnostics(current, { performanceThresholdMs: 6 }),
  );
  current.observations[0].observations[0].status = 'succeeded';
  const drift = structuredClone(current.inventory);
  drift.profiles[0].counts.descriptors++;
  assert.throws(
    () =>
      commandTimingDiagnostics(current, {
        performanceThresholdMs: 6,
        inventory: drift,
      }),
    /recorded profiles/u,
  );
});

test('active runners use diagnostics and count gates', async () => {
  const capacity = await readFile(
    'tools/protocol-probe/command-capacity-runner.mjs',
    'utf8',
  );
  const navigation = await readFile('tools/navigation-app-probe.mjs', 'utf8');
  assert.match(
    capacity,
    /assertNativeCommandCounts\(\s*summary,\s*inventory\.profiles,?\s*\)/u,
  );
  assert.match(capacity, /commandTimingDiagnostics\(summary, baseline\)/u);
  assert.match(navigation, /shortModelTimingDiagnostics\(summary, baseline\)/u);
});

test('inventory follows larger/tied source hierarchies and preserves required notification descriptor', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'gattlab-capacity-inventory-'));
  try {
    const files = [
      'tools/vanilla-app-fixtures/model.ts',
      'tools/blazor-app-fixtures/model.ts',
      'packages/playwright/e2e/model.ts',
      'packages/cdp/test/model.chromium.test.ts',
    ];
    const model =
      'const model = { address: "01:02:03:04:05:06", services: [{ uuid: "180f", characteristics: [{ uuid: "2a19", properties: ["notify"], descriptors: [{uuid: "2902"}] }] }] };';
    for (const file of files) {
      await mkdir(resolve(root, file, '..'), { recursive: true });
      await writeFile(resolve(root, file), model);
    }
    const first = await commandCapacityInventory(root);
    assert.equal(first.profiles.length, 4);
    assert.equal(
      first.profiles[0].definition.services[0].characteristics[0].descriptors[0]
        .uuid,
      '00002902-0000-1000-8000-00805f9b34fb',
    );
    await writeFile(
      resolve(root, files[0]),
      model +
        '\nconst larger = { services: [{uuid: "180f", characteristics: [{uuid: "2a19", properties: ["read"], descriptors: [{uuid: "2901"}, {uuid: "2902"}]}]}] };',
    );
    const larger = await commandCapacityInventory(root);
    assert.equal(
      larger.profiles.filter(({ family }) => family === 'vanilla').length,
      1,
    );
    assert.equal(
      larger.profiles.find(({ family }) => family === 'vanilla').counts
        .descriptors,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
