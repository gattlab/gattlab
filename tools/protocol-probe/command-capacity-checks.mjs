import assert from 'node:assert/strict';

export function assertCommandCapacity(
  summary,
  profiles,
  { requireClean = false } = {},
) {
  assert.equal(summary.status, 'passed');
  assert.match(summary.sourceSha, /^[a-f0-9]{40}$/u);
  if (requireClean)
    assert.equal(
      summary.clean,
      true,
      'Command-count checks require clean committed source',
    );
  assert.deepEqual(summary.compilerVersions, ['6.0.3', '5.9.3']);
  assert.equal(summary.cleanup?.allExited, true);
  assert.equal(summary.cleanup?.registeredServers, 1);
  assert.equal(summary.observations.length, profiles.length * 2);
  const mandatory = [
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
  ];
  const all = [];
  for (const profile of profiles)
    for (const mode of ['cdp', 'playwright']) {
      const matches = summary.observations.filter(
        (entry) => entry.profileId === profile.id && entry.mode === mode,
      );
      assert.equal(
        matches.length,
        1,
        'Every inventory profile/boundary requires one result',
      );
      const entry = matches[0];
      assert.equal(entry.browserVersion, '159.0.8154.6');
      assert.ok(entry.observations.length > 0);
      const operations = new Set(
        entry.observations.map(({ operation }) => operation),
      );
      for (const operation of [
        mode === 'cdp' ? 'addPeripheral' : 'createPeripheral',
        ...mandatory,
      ])
        assert.ok(
          operations.has(operation),
          `Missing ${operation} command measurement`,
        );
      for (const sample of entry.observations) {
        assert.equal(sample.status, 'succeeded');
        assert.ok(Number.isFinite(sample.elapsedMs) && sample.elapsedMs > 0);
        assert.ok(
          Number.isSafeInteger(sample.commandCount) && sample.commandCount >= 0,
        );
        assert.ok(
          sample.commandCount > 0 ||
            (mode === 'cdp' &&
              sample.operation === 'createPreconnectedPeripheral'),
          'Only direct preconnection after identity bootstrap may send no command',
        );
        all.push(sample);
      }
    }
  for (const mode of ['cdp', 'playwright']) {
    for (const operation of [
      'respondToCharacteristicOperation',
      'respondToDescriptorOperation',
    ]) {
      assert.ok(
        summary.observations.some(
          (entry) =>
            entry.mode === mode &&
            entry.observations.some((sample) => sample.operation === operation),
        ),
        `Missing ${mode} ${operation} measurement`,
      );
    }
  }
  return {
    maximumMs: Math.max(...all.map(({ elapsedMs }) => elapsedMs)),
    sampleCount: all.length,
  };
}

export function assertNativeCommandCounts(summary, profiles) {
  const coverage = assertCommandCapacity(summary, profiles);
  for (const profile of profiles) {
    const modelLimit =
      1 +
      profile.counts.services +
      profile.counts.characteristics +
      profile.counts.descriptors;
    for (const entry of summary.observations.filter(
      (row) => row.profileId === profile.id,
    )) {
      for (const sample of entry.observations) {
        let limit;
        if (
          ['addPeripheral', 'createPeripheral', 'disconnect'].includes(
            sample.operation,
          )
        )
          limit = modelLimit;
        else if (sample.operation === 'createPreconnectedPeripheral')
          limit = entry.mode === 'cdp' ? 0 : modelLimit;
        else if (['select', 'selectById', 'cancel'].includes(sample.operation))
          limit = 2;
        else if (
          [
            'simulateAdvertisement',
            'liveness-check',
            'setCentralState:absent',
            'setCentralState:powered-off',
            'setCentralState:powered-on',
            'respondToGattOperation',
            'respondToCharacteristicOperation',
            'respondToDescriptorOperation',
          ].includes(sample.operation)
        )
          limit = 1;
        else assert.fail(`Unknown command-count operation ${sample.operation}`);
        assert.ok(
          sample.commandCount <= limit,
          `${profile.id}/${entry.mode}/${sample.operation}: ${sample.commandCount} sends exceed command-count budget ${limit}`,
        );
      }
    }
  }
  return { status: 'passed', sampleCount: coverage.sampleCount };
}

// Current timings are diagnostics only; they never fail the run.
export function commandTimingDiagnostics(summary, baseline) {
  const { maximumMs } = assertCommandCapacity(
    summary,
    summary.inventory.profiles,
  );
  const geometry = (inventory) =>
    inventory.profiles.map(
      ({ id, family, file, owner, occurrence, counts, services }) => ({
        id,
        family,
        file,
        owner,
        occurrence,
        counts,
        services,
      }),
    );
  assert.deepEqual(
    geometry(summary.inventory),
    geometry(baseline.inventory),
    'Command model identities/topology/properties must preserve the recorded profiles',
  );
  const thresholdMs = baseline.performanceThresholdMs;
  assert.ok(Number.isFinite(thresholdMs) && thresholdMs > 0);
  return {
    status: 'diagnostic-only',
    maximumMs,
    historicalThresholdMs: thresholdMs,
    samplesOverHistoricalThreshold: summary.observations
      .flatMap((row) => row.observations)
      .filter((sample) => sample.elapsedMs > thresholdMs).length,
    baselineSourceSha: baseline.sourceSha,
  };
}
