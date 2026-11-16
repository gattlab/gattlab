import assert from 'node:assert/strict';
import { PUBLIC_NAVIGATION_CASES } from './navigation-public-manifest.mjs';
import {
  MAX_CLOSE_STEPS,
  isDestructiveRegistration,
  assertModelTimeoutEvidence,
} from './public-close-sequence.mjs';

export function assertPublicConsumerSource(source) {
  assert.doesNotMatch(
    source,
    /newBrowserCDPSession|newCDPSession|Target\.|BluetoothEmulation\.|DeviceAccess\./u,
    'Public navigation regression must not use raw CDP or a native destruction barrier',
  );
}

export function assertCloseEvidence(evidence) {
  assert.ok(['continued', 'invalidated'].includes(evidence.closeOutcome));
  assert.ok(
    Number.isSafeInteger(evidence.closeSteps) &&
      evidence.closeSteps > 0 &&
      evidence.closeSteps <= MAX_CLOSE_STEPS,
  );
  if (evidence.closeOutcome === 'continued') {
    assert.equal(evidence.closeSteps, MAX_CLOSE_STEPS);
    assert.equal(evidence.verifiedRegistrations, MAX_CLOSE_STEPS);
    assert.equal(evidence.invalidations, 0);
    assert.equal(evidence.reason, undefined);
    return true;
  }
  assert.equal(evidence.verifiedRegistrations, evidence.closeSteps - 1);
  if (evidence.reason === 'model-outcome-unknown') {
    assert.equal(evidence.typedLossVerified, false);
    assert.equal(evidence.typedModelAbortVerified, true);
    assert.ok(
      ['createPeripheral', 'advertise'].includes(evidence.terminalOperation),
    );
    assert.equal(evidence.lossOperation, undefined);
    assertModelTimeoutEvidence(evidence.modelTimeout);
  } else {
    assert.equal(evidence.reason, 'adapter-lost');
    assert.equal(evidence.typedLossVerified, true);
    assert.notEqual(evidence.typedModelAbortVerified, true);
    assert.ok(
      ['createPeripheral', 'advertise'].includes(evidence.lossOperation),
    );
  }
  return false;
}

// Keep enough code-only evidence to locate a failed assertion without exporting
// error messages, snippets, filesystem paths or Bluetooth payload values.
export function failedTestDiagnostic(observed, annotations = []) {
  let stoppedContext;
  try {
    const context = JSON.parse(
      annotations.findLast(({ type }) => type === 'navigation-stopped-context')
        ?.description ?? 'null',
    );
    const vocabulary = {
      reason: ['adapter-lost', 'fixture-page-closed', 'model-outcome-unknown'],
      lifecycleState: ['invalidated'],
      operation: ['createPeripheral', 'advertise'],
      operationLayer: ['cdp', 'playwright'],
      detectedBy: [
        'command-rejection',
        'liveness-check',
        'fixture-page-close',
        'model-operation-aborted',
      ],
      remediation: ['new-test-fixture'],
    };
    if (context && typeof context === 'object' && !Array.isArray(context)) {
      const entries = Object.entries(vocabulary).filter(([key, allowed]) =>
        allowed.includes(context[key]),
      );
      if (entries.length)
        stoppedContext = Object.fromEntries(
          entries.map(([key]) => [key, context[key]]),
        );
    }
  } catch {
    // Malformed diagnostic annotations cannot publish arbitrary values.
  }
  const phase = annotations.findLast(
    ({ type }) => type === 'navigation-phase',
  )?.description;
  const knownPhases = [
    'prepare',
    'initial-model',
    'prerequisite',
    'stimulus',
    'post-close-registration',
    'verify-registration',
    'terminal-handles',
    'dispose',
    'completed',
  ];
  const error = observed.error ?? observed.errors?.[0];
  const message = (error?.message ?? '').replace(/\u001b\[[0-9;]*m/gu, '');
  const matcher = /expect\(received\)\.(to[A-Za-z]+)/u.exec(message)?.[1];
  const receivedType = /Received constructor: ([A-Za-z]+Error)/u.exec(
    message,
  )?.[1];
  const knownTypes = [
    'Error',
    'TypeError',
    'CdpTransportError',
    'BluetoothBackendStoppedError',
    'BluetoothTimeoutError',
    'BluetoothCancelledError',
    'BluetoothValidationError',
    'BluetoothConcurrentOperationError',
  ];
  const knownMatchers = [
    'toBe',
    'toEqual',
    'toMatchObject',
    'toBeInstanceOf',
    'toHaveLength',
    'toBeDefined',
    'toBeGreaterThan',
  ];
  const locations = [
    ...(error?.stack ?? '').matchAll(/navigation\.spec\.ts:(\d+):(\d+)/gu),
  ]
    .slice(0, 8)
    .map((match) => ({ line: Number(match[1]), column: Number(match[2]) }));
  return {
    outcome: observed.status,
    ...(stoppedContext ? { stoppedContext } : {}),
    ...(knownPhases.includes(phase) ? { phase } : {}),
    ...(knownMatchers.includes(matcher) ? { matcher } : {}),
    ...(knownTypes.includes(receivedType) ? { receivedType } : {}),
    ...(message.includes('Expected a typed lifecycle rejection')
      ? { reason: 'expected-lifecycle-rejection-missing' }
      : {}),
    locations,
  };
}

export function assertPublicNavigation(summary) {
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.status, 'passed');
  assert.match(summary.sourceSha, /^[a-f0-9]{40}$/u);
  assert.deepEqual(summary.compilerVersions, ['6.0.3', '5.9.3']);
  assert.equal(summary.cleanup?.allExited, true);
  assert.equal(summary.invocations.length, PUBLIC_NAVIGATION_CASES.length);
  const expected = PUBLIC_NAVIGATION_CASES.flatMap((row) => row.testIds);
  const terminalOutcomes = {
    adapterLost: 0,
    modelOutcomeUnknown: 0,
    fixturePageClosed: 0,
    continued: 0,
  };
  assert.equal(summary.results.length, expected.length);
  for (const id of expected) {
    const rows = summary.results.filter((row) => row.caseId === id);
    assert.equal(rows.length, 1, `Missing or duplicate installed case ${id}`);
    const row = rows[0];
    const scenario = PUBLIC_NAVIGATION_CASES.find((entry) =>
      entry.testIds.includes(id),
    );
    assert.equal(
      row.status,
      scenario.expectedCleanupFailure ? 'expected-cleanup-failure' : 'passed',
      `Installed case failed: ${id}`,
    );
    if (scenario.expectedCleanupFailure)
      assert.equal(row.cleanupFailureVerified, true);
    assert.equal(row.attempts, 1, 'No retries qualify');
    assert.equal(row.browserVersion, '159.0.8154.6');
    assert.ok(row.observations && typeof row.observations === 'object');
    const evidence = row.observations;
    if (scenario.group === 'N10') {
      if (id.endsWith(':dispose')) assert.equal(evidence.idempotent, true);
      else {
        assert.equal(evidence.sameBrowser, true);
        assert.equal(evidence.emptyChooser, true);
        assert.equal(evidence.read, 87);
      }
    } else if (scenario.group === 'short-assertion') {
      assert.equal(evidence.operationTimeoutMs, 1);
      assert.equal(evidence.shortWaitDeadlineMs, 1);
      assert.deepEqual(evidence.profileIds, summary.capacityProfileIds);
      assert.equal(evidence.exposure, true);
      assert.equal(
        evidence.samples.length,
        summary.capacityProfileIds.length * 3,
      );
      assert.ok(evidence.samples.some((sample) => sample.elapsedMs > 1));
      for (const profileId of summary.capacityProfileIds)
        for (const operation of [
          'createPeripheral',
          'createPreconnectedPeripheral',
          'disconnect',
        ]) {
          const samples = evidence.samples.filter(
            (sample) =>
              sample.profileId === profileId && sample.operation === operation,
          );
          assert.equal(samples.length, 1);
          assert.ok(
            Number.isFinite(samples[0].elapsedMs) && samples[0].elapsedMs > 0,
          );
        }
    } else if (scenario.group === 'state') {
      assert.equal(evidence.preservedState, scenario.state);
      assert.equal(evidence.read, 87);
    } else {
      const control =
        scenario.level === 'U0' ||
        [
          'hash',
          'history',
          'scripted-disconnect',
          'native-disconnect',
          'lazy-goto',
        ].includes(scenario.action) ||
        scenario.retainedFixture === true;
      assert.equal(evidence.control, control);
      assert.ok(Number.isFinite(evidence.elapsedMs) && evidence.elapsedMs > 0);
      const racedClose =
        !control &&
        scenario.action === 'close' &&
        ['same-context', 'other-context'].includes(scenario.subject);
      const continued = racedClose && assertCloseEvidence(evidence);
      if (control) {
        assert.equal(evidence.read, 87);
        assert.notEqual(evidence.reason, 'model-outcome-unknown');
        assert.equal(evidence.modelTimeout, undefined);
        assert.notEqual(evidence.typedModelAbortVerified, true);
      } else if (continued) {
        terminalOutcomes.continued += 1;
        if (scenario.group === 'N9') {
          assert.equal(evidence.destructions, 2);
          assert.deepEqual(evidence.initialConcurrent, [
            'fulfilled',
            'fulfilled',
          ]);
        }
      } else {
        if (evidence.reason === 'model-outcome-unknown') {
          assert.equal(isDestructiveRegistration(scenario), true);
          assert.equal(evidence.typedLossVerified, false);
          assert.equal(evidence.typedModelAbortVerified, true);
          assertModelTimeoutEvidence(evidence.modelTimeout);
          terminalOutcomes.modelOutcomeUnknown += 1;
        } else {
          const expectedReason =
            scenario.subject === 'fixture' && scenario.action === 'close'
              ? 'fixture-page-closed'
              : 'adapter-lost';
          assert.equal(evidence.reason, expectedReason);
          assert.equal(evidence.modelTimeout, undefined);
          assert.notEqual(evidence.typedModelAbortVerified, true);
          terminalOutcomes[
            expectedReason === 'adapter-lost'
              ? 'adapterLost'
              : 'fixturePageClosed'
          ] += 1;
        }
        assert.equal(evidence.invalidations, 1);
        if (scenario.group === 'N8') {
          assert.equal(evidence.pendingWaitSettled, true);
          if (scenario.level === 'pending-read') {
            assert.equal(evidence.pendingReadConfirmed, true);
            assert.equal(evidence.lateDeliveryFailed, true);
          }
        }
        if (scenario.group === 'N9') {
          assert.equal(evidence.concurrentRejected, 2);
          assert.equal(evidence.destructions, 2);
        }
      }
      const before = evidence.prerequisite;
      assert.ok(before && Array.isArray(before.apiCalls));
      if (scenario.level === 'U0') assert.deepEqual(before.apiCalls, []);
      if (['U1', 'pending-chooser'].includes(scenario.level)) {
        assert.equal(before.availability, true);
        assert.ok(before.apiCalls.includes('getAvailability'));
      }
      if (scenario.level === 'U2') {
        assert.equal(before.request?.status, 'rejected');
        assert.equal(before.request?.error, 'NotFoundError');
      }
      if (scenario.level === 'U3') {
        assert.equal(before.request?.status, 'selected');
        assert.deepEqual(before.operations, []);
      }
      if (['U4', 'pending-read'].includes(scenario.level))
        assert.ok(
          before.operations.some(
            (operation) =>
              operation.name === 'read' &&
              operation.status === 'resolved' &&
              operation.value === 87,
          ),
        );
      if (scenario.level === 'pending-request')
        assert.deepEqual(before.request, {
          invoked: true,
          callReturned: true,
          status: 'pending',
        });
    }
  }
  for (const row of PUBLIC_NAVIGATION_CASES) {
    const invocation = summary.invocations.filter((run) => run.id === row.id);
    assert.equal(invocation.length, 1);
    assert.equal(invocation[0].status, 'passed');
    assert.equal(invocation[0].freshProcess, true);
    assert.deepEqual(invocation[0].caseIds, row.testIds);
    assert.equal(invocation[0].cleanup?.allExited, true);
    assert.equal(
      invocation[0].cleanup?.registeredServers,
      row.action === 'other-origin' ? 2 : 1,
    );
    assert.match(invocation[0].reportSha256, /^[a-f0-9]{64}$/u);
  }
  for (const subject of ['same-context', 'other-context']) {
    for (const level of ['U0', 'U1', 'pending-request'])
      for (const action of ['goto', 'close'])
        assert.ok(expected.includes(`public:N7-${subject}-${level}-${action}`));
    for (const level of ['U1', 'pending-request']) {
      const family = PUBLIC_NAVIGATION_CASES.filter(
        (row) =>
          row.subject === subject &&
          row.level === level &&
          row.action === 'close' &&
          row.retainedFixture !== true,
      ).flatMap((row) => row.testIds);
      assert.ok(
        summary.results.some(
          (row) =>
            family.includes(row.caseId) &&
            row.observations.closeOutcome === 'invalidated',
        ),
        `Missing observed invalidation in close family ${subject}/${level}`,
      );
    }
  }
  if (summary.terminalOutcomes !== undefined)
    assert.deepEqual(summary.terminalOutcomes, terminalOutcomes);
  return {
    caseCount: expected.length,
    processCount: PUBLIC_NAVIGATION_CASES.length,
    terminalOutcomes,
  };
}

// Expected fixture teardown failures are narrowly whitelisted only after the
// consumer completed all active lifecycle assertions and verified both members.
export function assertExpectedCleanupFailure(test, observed, attachment) {
  assert.equal(
    attachment?.observations?.cleanupFailureVerified,
    true,
    'Completed lifecycle evidence is mandatory',
  );
  assert.equal(test.expectedStatus, 'failed');
  assert.equal(observed.status, 'failed');
  const messages = (observed.errors ?? []).map((error) => error.message ?? '');
  assert.equal(
    messages.length,
    3,
    'Only one AggregateError and its two closed-page members qualify',
  );
  assert.match(
    messages[0],
    /^AggregateError: Bluetooth backend teardown completed with 2 cleanup failure\(s\): DeviceAccess\.disable, page-session\.detach\./u,
  );
  assert.match(
    messages[1],
    /^CdpTransportError: CDP DeviceAccess\.disable failed on the page session\./u,
  );
  assert.match(
    messages[2],
    /^Error: cdpSession\.detach: Target page, context or browser has been closed/u,
  );
  return true;
}

export function shortModelTimingDiagnostics(summary, baseline) {
  assert.deepEqual(
    summary.capacityProfileIds,
    baseline.inventory.profiles.map(({ id }) => id),
  );
  const samples = summary.results.flatMap(
    (row) => row.observations?.samples ?? [],
  );
  assert.ok(samples.length > 0);
  assert.ok(
    samples.every(
      (sample) => Number.isFinite(sample.elapsedMs) && sample.elapsedMs > 0,
    ),
  );
  assert.ok(
    Number.isFinite(baseline.performanceThresholdMs) &&
      baseline.performanceThresholdMs > 0,
  );
  return {
    status: 'diagnostic-only',
    maximumMs: Math.max(...samples.map(({ elapsedMs }) => elapsedMs)),
    historicalThresholdMs: baseline.performanceThresholdMs,
    samplesOverHistoricalThreshold: samples.filter(
      (sample) => sample.elapsedMs > baseline.performanceThresholdMs,
    ).length,
    baselineSourceSha: baseline.sourceSha,
  };
}
