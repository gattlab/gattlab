import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  observePublicClose,
  MAX_CLOSE_STEPS,
  assertModelCommandAbort,
  assertModelTimeoutEvidence,
  isDestructiveRegistration,
} from './public-close-sequence.mjs';
import { PUBLIC_NAVIGATION_CASES } from './navigation-public-manifest.mjs';
import {
  assertPublicNavigation,
  assertExpectedCleanupFailure,
  failedTestDiagnostic,
  assertPublicConsumerSource,
  assertCloseEvidence,
  shortModelTimingDiagnostics,
} from './navigation-checks.mjs';

test('public close accepts verified registrations and a checked loss within three operations', async () => {
  const loss = new Error('checked loss');
  for (const successes of [0, 1, 2, 3]) {
    const calls = [];
    const verified = [];
    const result = await observePublicClose(
      async (step) => {
        calls.push(step);
        if (step === successes) throw loss;
        return { step, registered: true };
      },
      (value, step) => {
        assert.equal(value.step, step);
        assert.equal(value.registered, true);
        verified.push(step);
      },
      (cause) => assert.equal(cause, loss),
    );
    assert.equal(result.outcome, successes === 3 ? 'continued' : 'invalidated');
    assert.equal(result.verifiedRegistrations, successes);
    assert.equal(result.steps, Math.min(successes + 1, MAX_CLOSE_STEPS));
    assert.equal(calls.length, result.steps);
    assert.equal(verified.length, successes);
  }
});

test('public close rejects untyped errors and false registration success without retries', async () => {
  const foreign = new Error('untyped transport');
  let calls = 0;
  for (const run of [
    () => {
      throw foreign;
    },
    async () => {
      throw foreign;
    },
  ])
    await assert.rejects(
      observePublicClose(
        () => {
          calls++;
          return run();
        },
        () => {},
        () => {
          throw foreign;
        },
      ),
      (cause) => cause === foreign,
    );
  assert.equal(calls, 2);
  const falseSuccess = new Error('unverified registration');
  await assert.rejects(
    observePublicClose(
      async () => ({}),
      () => {
        throw falseSuccess;
      },
      () => {},
    ),
    (cause) => cause === falseSuccess,
  );
});

test('close evidence cannot accept unverified continuation, unknown errors or unbounded steps', () => {
  const continued = {
    closeOutcome: 'continued',
    closeSteps: 3,
    verifiedRegistrations: 3,
    invalidations: 0,
  };
  assert.equal(assertCloseEvidence(continued), true);
  for (const change of [
    { verifiedRegistrations: 0 },
    { closeSteps: 1 },
    { closeSteps: 4 },
    { invalidations: 1 },
    { reason: 'adapter-lost' },
  ])
    assert.throws(() => assertCloseEvidence({ ...continued, ...change }));
  const stopped = {
    reason: 'adapter-lost',
    closeOutcome: 'invalidated',
    closeSteps: 2,
    verifiedRegistrations: 1,
    typedLossVerified: true,
    lossOperation: 'createPeripheral',
  };
  assert.equal(assertCloseEvidence(stopped), false);
  assert.throws(() =>
    assertCloseEvidence({ ...stopped, typedLossVerified: false }),
  );
});

const modelTimeoutEvidence = () => ({
  causeType: 'BluetoothTimeoutError',
  code: 'BLUETOOTH_TIMEOUT',
  operation: 'createPeripheral',
  operationLayer: 'playwright',
  deadlineKind: 'command',
  timeoutPhase: 'operation',
  deadlineMs: 30000,
  checkDeadlineMs: 30000,
  detection: 'not-checked',
  centralStateBlocked: false,
  remediation: 'inspect-operation',
  causeRetained: true,
});
class Timeout extends Error {
  constructor(context, code = 'BLUETOOTH_TIMEOUT') {
    super('timeout');
    this.name = 'BluetoothTimeoutError';
    this.code = code;
    this.context = Object.freeze(context);
  }
}
class Stopped extends Error {
  constructor(context, cause, code = 'BLUETOOTH_BACKEND_STOPPED') {
    super('stopped', { cause });
    this.code = code;
    this.context = Object.freeze(context);
  }
}
const abortContext = () => ({
  reason: 'model-outcome-unknown',
  lifecycleState: 'invalidated',
  operation: 'createPeripheral',
  operationLayer: 'playwright',
  detectedBy: 'model-operation-aborted',
  boundary: 'unobserved',
  remediation: 'new-test-fixture',
});
function timeoutCause(change = {}) {
  const { causeType, code, causeRetained, ...context } = modelTimeoutEvidence();
  return new Timeout({ ...context, ...change });
}
const abortExpected = { operation: 'createPeripheral', boundary: 'unobserved' };
const abortTypes = { stopped: Stopped, timeout: Timeout };

test('model abort requires exact stopped fields, typed original watchdog and retained identity', () => {
  const timeout = timeoutCause();
  const error = new Stopped(abortContext(), timeout);
  const checked = assertModelCommandAbort(error, abortExpected, abortTypes);
  assert.equal(checked.timeout, timeout);
  assert.deepEqual(checked.evidence, modelTimeoutEvidence());
  assertModelCommandAbort(
    error,
    { ...abortExpected, retainedCause: timeout },
    abortTypes,
  );
  assert.throws(() =>
    assertModelCommandAbort(
      error,
      { ...abortExpected, retainedCause: timeoutCause() },
      abortTypes,
    ),
  );
  for (const key of Object.keys(abortContext())) {
    const wrong = new Stopped({ ...abortContext(), [key]: 'foreign' }, timeout);
    assert.throws(
      () => assertModelCommandAbort(wrong, abortExpected, abortTypes),
      key,
    );
  }
  for (const [key, value] of Object.entries(timeout.context)) {
    for (const wrong of [
      undefined,
      'foreign',
      typeof value === 'number' ? value + 1 : null,
    ])
      assert.throws(
        () =>
          assertModelCommandAbort(
            new Stopped(abortContext(), timeoutCause({ [key]: wrong })),
            abortExpected,
            abortTypes,
          ),
        key,
      );
  }
  for (const foreign of [
    new Error('foreign'),
    Object.assign(new Error('stopped lookalike'), {
      code: 'BLUETOOTH_BACKEND_STOPPED',
      context: Object.freeze(abortContext()),
      cause: timeout,
    }),
    timeout,
    new Stopped(abortContext(), new Error('timeout')),
    new Stopped(abortContext(), timeout, 'BLUETOOTH_CANCELLED'),
    new Stopped({ ...abortContext(), state: 'stopped' }, timeout),
    new Stopped(
      abortContext(),
      new Timeout(timeout.context, 'BLUETOOTH_CANCELLED'),
    ),
    new Stopped(
      abortContext(),
      Object.assign(new Error('timeout lookalike'), {
        name: 'BluetoothTimeoutError',
        code: 'BLUETOOTH_TIMEOUT',
        context: timeout.context,
      }),
    ),
  ])
    assert.throws(() =>
      assertModelCommandAbort(foreign, abortExpected, abortTypes),
    );
  const mutableTimeout = timeoutCause();
  mutableTimeout.context = { ...mutableTimeout.context };
  assert.throws(() =>
    assertModelCommandAbort(
      new Stopped(abortContext(), mutableTimeout),
      abortExpected,
      abortTypes,
    ),
  );
  error.context = { ...error.context };
  assert.throws(() =>
    assertModelCommandAbort(error, abortExpected, abortTypes),
  );
});

test('reported model timeout rejects each changed or missing field and extra data', () => {
  assertModelTimeoutEvidence(modelTimeoutEvidence());
  for (const key of Object.keys(modelTimeoutEvidence())) {
    const missing = modelTimeoutEvidence();
    delete missing[key];
    assert.throws(() => assertModelTimeoutEvidence(missing), key);
    assert.throws(
      () =>
        assertModelTimeoutEvidence({
          ...modelTimeoutEvidence(),
          [key]: 'foreign',
        }),
      key,
    );
  }
  assert.throws(() =>
    assertModelTimeoutEvidence({
      ...modelTimeoutEvidence(),
      payload: 'private',
    }),
  );
});

test('model uncertainty is confined to destructive registration, excluding controls and fixture close', () => {
  for (const id of [
    'public:N7-other-context-pending-request-goto',
    'public:N7-other-context-U1-close',
  ])
    assert.equal(
      isDestructiveRegistration(
        PUBLIC_NAVIGATION_CASES.find((row) => row.id === id),
      ),
      true,
    );
  for (const row of PUBLIC_NAVIGATION_CASES.filter(
    (row) =>
      row.level === 'U0' ||
      row.retainedFixture ||
      row.action === 'hash' ||
      row.action === 'history' ||
      (row.subject === 'fixture' && row.action === 'close') ||
      row.group === 'N8',
  ))
    assert.equal(isDestructiveRegistration(row), false, row.id);
});

test('public consumer forbids native CDP destruction barriers', async () => {
  const source = await readFile(
    'tools/protocol-probe/navigation.spec.ts',
    'utf8',
  );
  assertPublicConsumerSource(source);
  for (const drift of [
    'browser.newBrowserCDPSession()',
    'context.newCDPSession(page)',
    'Target.targetDestroyed',
  ])
    assert.throws(() => assertPublicConsumerSource(`${source}\n${drift}`));
});

test('failed assertion evidence retains code locations and excludes raw payloads and paths', () => {
  const observed = {
    status: 'failed',
    error: {
      message:
        'Error: expect(received).toBeInstanceOf(expected)\nsecret payload [1,2,3]',
      stack:
        'Error: secret\n at assertStopped (/private/owner/tests/navigation.spec.ts:303:17)\n at test (/private/owner/tests/navigation.spec.ts:734:9)',
    },
  };
  assert.deepEqual(failedTestDiagnostic(observed), {
    outcome: 'failed',
    matcher: 'toBeInstanceOf',
    locations: [
      { line: 303, column: 17 },
      { line: 734, column: 9 },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(failedTestDiagnostic(observed)),
    /secret|payload|private|owner/u,
  );
  assert.equal(
    failedTestDiagnostic({ status: 'timedOut' }, [
      { type: 'navigation-phase', description: 'prepare' },
      { type: 'navigation-phase', description: 'post-close-registration' },
    ]).phase,
    'post-close-registration',
  );
  assert.equal(
    failedTestDiagnostic({ status: 'timedOut' }, [
      { type: 'navigation-phase', description: 'secret payload /owner/path' },
    ]).phase,
    undefined,
  );
  assert.equal(
    failedTestDiagnostic({
      status: 'failed',
      error: { message: 'Error: Expected a typed lifecycle rejection' },
    }).reason,
    'expected-lifecycle-rejection-missing',
  );
  assert.equal(
    failedTestDiagnostic({
      status: 'failed',
      error: {
        message:
          'Error: expect(received).toBeInstanceOf(expected)\nReceived constructor: CdpTransportError',
      },
    }).receivedType,
    'CdpTransportError',
  );
});
test('failed lifecycle diagnostics retain only approved enum fields', () => {
  const diagnostic = (description) =>
    failedTestDiagnostic({ status: 'failed' }, [
      { type: 'navigation-stopped-context', description },
    ]);
  assert.deepEqual(
    diagnostic(
      JSON.stringify({
        reason: 'model-outcome-unknown',
        lifecycleState: 'invalidated',
        operation: 'createPeripheral',
        operationLayer: 'playwright',
        detectedBy: 'model-operation-aborted',
        remediation: 'new-test-fixture',
        payload: 'secret /owner/path',
      }),
    ).stoppedContext,
    {
      reason: 'model-outcome-unknown',
      lifecycleState: 'invalidated',
      operation: 'createPeripheral',
      operationLayer: 'playwright',
      detectedBy: 'model-operation-aborted',
      remediation: 'new-test-fixture',
    },
  );
  for (const description of [
    'secret /owner/path',
    'null',
    '[]',
    '"adapter-lost"',
    JSON.stringify({ reason: 'secret /owner/path', operation: 'payload' }),
    JSON.stringify({ reason: ['adapter-lost'], operation: { payload: 7 } }),
  ])
    assert.deepEqual(diagnostic(description), {
      outcome: 'failed',
      locations: [],
    });
});
function observations(row, id) {
  if (row.group === 'N10')
    return id.endsWith(':dispose')
      ? { idempotent: true }
      : { sameBrowser: true, emptyChooser: true, read: 87 };
  if (row.group === 'short-assertion')
    return {
      operationTimeoutMs: 1,
      shortWaitDeadlineMs: 1,
      exposure: true,
      profileIds: ['profile'],
      samples: [
        'createPeripheral',
        'createPreconnectedPeripheral',
        'disconnect',
      ].map((operation) => ({ profileId: 'profile', operation, elapsedMs: 2 })),
    };
  if (row.group === 'state') return { preservedState: row.state, read: 87 };
  const control =
    row.level === 'U0' ||
    [
      'hash',
      'history',
      'scripted-disconnect',
      'native-disconnect',
      'lazy-goto',
    ].includes(row.action) ||
    row.retainedFixture === true;
  const before = { apiCalls: [], operations: [] };
  if (['U1', 'pending-chooser'].includes(row.level)) {
    before.apiCalls.push('getAvailability');
    before.availability = true;
  }
  if (row.level === 'U2')
    before.request = { status: 'rejected', error: 'NotFoundError' };
  if (row.level === 'U3') before.request = { status: 'selected' };
  if (['U4', 'pending-read'].includes(row.level))
    before.operations.push({ name: 'read', status: 'resolved', value: 87 });
  if (row.level === 'pending-request')
    before.request = { invoked: true, callReturned: true, status: 'pending' };
  return {
    control,
    ...(!control &&
    row.action === 'close' &&
    ['same-context', 'other-context'].includes(row.subject)
      ? {
          closeOutcome: 'invalidated',
          closeSteps: 1,
          verifiedRegistrations: 0,
          typedLossVerified: true,
          lossOperation: 'createPeripheral',
        }
      : {}),
    elapsedMs: 1,
    read: 87,
    prerequisite: before,
    reason:
      row.subject === 'fixture' && row.action === 'close'
        ? 'fixture-page-closed'
        : 'adapter-lost',
    invalidations: 1,
    pendingWaitSettled: true,
    pendingReadConfirmed: true,
    lateDeliveryFailed: true,
    concurrentRejected: 2,
    destructions: 2,
  };
}
function summary() {
  return {
    schemaVersion: 1,
    status: 'passed',
    sourceSha: 'a'.repeat(40),
    capacityProfileIds: ['profile'],
    compilerVersions: ['6.0.3', '5.9.3'],
    cleanup: { allExited: true },
    invocations: PUBLIC_NAVIGATION_CASES.map((row) => ({
      id: row.id,
      status: 'passed',
      freshProcess: true,
      caseIds: row.testIds,
      reportSha256: 'b'.repeat(64),
      cleanup: {
        registeredServers: row.action === 'other-origin' ? 2 : 1,
        allExited: true,
      },
    })),
    results: PUBLIC_NAVIGATION_CASES.flatMap((row) =>
      row.testIds.map((caseId) => ({
        caseId,
        status: row.expectedCleanupFailure
          ? 'expected-cleanup-failure'
          : 'passed',
        cleanupFailureVerified: row.expectedCleanupFailure === true,
        attempts: 1,
        browserVersion: '159.0.8154.6',
        observations: observations(row, caseId),
      })),
    ),
  };
}

test('installed model uncertainty is counted separately and cannot replace control or wait outcomes', () => {
  const fixture = summary();
  const target = fixture.results.find(
    (row) => row.caseId === 'public:N7-other-context-U1-close',
  );
  Object.assign(target.observations, {
    reason: 'model-outcome-unknown',
    typedLossVerified: false,
    typedModelAbortVerified: true,
    terminalOperation: 'createPeripheral',
    modelTimeout: modelTimeoutEvidence(),
  });
  delete target.observations.lossOperation;
  const counts = assertPublicNavigation(fixture).terminalOutcomes;
  assert.equal(counts.modelOutcomeUnknown, 1);
  assert.equal(
    counts.adapterLost,
    assertPublicNavigation(summary()).terminalOutcomes.adapterLost - 1,
  );
  for (const change of [
    { typedLossVerified: true },
    { typedModelAbortVerified: false },
    { modelTimeout: { ...modelTimeoutEvidence(), deadlineMs: 29999 } },
    { reason: 'cancelled' },
  ]) {
    const bad = structuredClone(fixture);
    Object.assign(
      bad.results.find((row) => row.caseId === target.caseId).observations,
      change,
    );
    assert.throws(() => assertPublicNavigation(bad));
  }
  const mislabeled = structuredClone(fixture);
  mislabeled.terminalOutcomes = {
    ...counts,
    adapterLost: counts.adapterLost + 1,
  };
  assert.throws(() => assertPublicNavigation(mislabeled));
  const badWait = summary();
  Object.assign(
    badWait.results.find(
      (row) => row.caseId === 'public:N8-fixture-pending-read-goto',
    ).observations,
    {
      reason: 'model-outcome-unknown',
      modelTimeout: modelTimeoutEvidence(),
      typedModelAbortVerified: true,
      typedLossVerified: false,
    },
  );
  assert.throws(() => assertPublicNavigation(badWait));
  const badControl = summary();
  Object.assign(
    badControl.results.find(
      (row) => row.caseId === 'public:N7-other-context-U0-close',
    ).observations,
    {
      reason: 'model-outcome-unknown',
      modelTimeout: modelTimeoutEvidence(),
      typedModelAbortVerified: true,
    },
  );
  assert.throws(() => assertPublicNavigation(badControl));
});
function continueClose(row) {
  delete row.observations.reason;
  Object.assign(row.observations, {
    closeOutcome: 'continued',
    closeSteps: 3,
    verifiedRegistrations: 3,
    invalidations: 0,
    initialConcurrent: ['fulfilled', 'fulfilled'],
  });
}

test('continued evidence requires exactly three steps and three verified registrations', () => {
  assert.throws(() =>
    assertCloseEvidence({
      closeOutcome: 'continued',
      closeSteps: 1,
      verifiedRegistrations: 3,
      invalidations: 0,
    }),
  );
});

test('installed close coverage accepts individual verified continuation and rejects missing public checks', () => {
  const value = summary();
  const closeRows = value.results.filter((result) => {
    const scenario = PUBLIC_NAVIGATION_CASES.find((row) =>
      row.testIds.includes(result.caseId),
    );
    return (
      scenario.action === 'close' &&
      ['same-context', 'other-context'].includes(scenario.subject) &&
      result.observations.control === false
    );
  });
  assert.ok(closeRows.length > 0);
  // N7 keeps observed loss in each family while N9 exercises continuation.
  for (const row of closeRows.filter(({ caseId }) =>
    caseId.startsWith('public:N9'),
  ))
    continueClose(row);
  assertPublicNavigation(value);
  for (const field of ['closeOutcome', 'verifiedRegistrations', 'closeSteps']) {
    const changed = structuredClone(value);
    const row = changed.results.find(
      (result) => result.caseId === closeRows[0].caseId,
    );
    delete row.observations[field];
    assert.throws(() => assertPublicNavigation(changed));
  }
  const missingConcurrent = structuredClone(value);
  missingConcurrent.results
    .find((row) => row.caseId === 'public:N9-same-context-U1-close')
    .observations.initialConcurrent.pop();
  assert.throws(() => assertPublicNavigation(missingConcurrent));
});
test('each participating close family must retain an observed invalidation', () => {
  for (const subject of ['same-context', 'other-context']) {
    for (const level of ['U1', 'pending-request']) {
      const value = summary();
      const family = PUBLIC_NAVIGATION_CASES.filter(
        (row) =>
          row.subject === subject &&
          row.level === level &&
          row.action === 'close',
      ).flatMap((row) => row.testIds);
      for (const row of value.results.filter(({ caseId }) =>
        family.includes(caseId),
      ))
        continueClose(row);
      assert.throws(
        () => assertPublicNavigation(value),
        new RegExp(
          `Missing observed invalidation in close family ${subject}/${level}`,
          'u',
        ),
      );
    }
  }
  // Invalidations elsewhere (fixture, navigation, controls) cannot rescue close.
  const allContinued = summary();
  for (const row of allContinued.results.filter(
    ({ observations }) => observations.closeOutcome,
  ))
    continueClose(row);
  assert.throws(
    () => assertPublicNavigation(allContinued),
    /Missing observed invalidation in close family/u,
  );
});
test('installed navigation rejects missing context/pending variants, retries and false cleanup', () => {
  assertPublicNavigation(summary());
  const mutations = [
    (value) =>
      value.results.splice(
        value.results.findIndex(
          (row) =>
            row.caseId === 'public:N7-other-context-pending-request-close',
        ),
        1,
      ),
    (value) => value.results.push(value.results[0]),
    (value) => (value.results[0].attempts = 2),
    (value) => (value.results[0].status = 'failed'),
    (value) => value.compilerVersions.pop(),
    (value) => (value.invocations[0].freshProcess = false),
    (value) => (value.invocations[0].cleanup.allExited = false),
    (value) => (value.invocations[0].cleanup.registeredServers = 2),
    (value) => (value.results[0].browserVersion = 'unknown'),
  ];
  for (const mutate of mutations) {
    const value = structuredClone(summary());
    mutate(value);
    assert.throws(() => assertPublicNavigation(value));
  }
});
test('public matrix owns every N group and retains fixture-only chooser boundary', () => {
  assert.deepEqual(
    [
      ...new Set(
        PUBLIC_NAVIGATION_CASES.filter((row) => row.group.startsWith('N')).map(
          (row) => row.group,
        ),
      ),
    ].sort(),
    ['N1', 'N10', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9'],
  );
  assert.ok(
    PUBLIC_NAVIGATION_CASES.every(
      (row) =>
        !(
          ['same-context', 'other-context'].includes(row.subject) &&
          ['U2', 'U3', 'U4'].includes(row.level)
        ),
    ),
  );
  assert.ok(
    PUBLIC_NAVIGATION_CASES.some(
      (row) => row.group === 'N10' && row.testIds.length === 2,
    ),
  );
});

test('expected cleanup failure rejects incomplete assertions and foreign errors', () => {
  const test = { expectedStatus: 'failed' };
  const observed = {
    status: 'failed',
    errors: [
      {
        message:
          'AggregateError: Bluetooth backend teardown completed with 2 cleanup failure(s): DeviceAccess.disable, page-session.detach.',
      },
      {
        message:
          'CdpTransportError: CDP DeviceAccess.disable failed on the page session.',
      },
      {
        message:
          'Error: cdpSession.detach: Target page, context or browser has been closed',
      },
    ],
  };
  const attachment = { observations: { cleanupFailureVerified: true } };
  assertExpectedCleanupFailure(test, observed, attachment);
  for (const message of [
    'Error: expect(received).toBe(expected)',
    'TimeoutError: startup expired',
    'Error: browser-session.detach failed',
  ]) {
    const changed = structuredClone(observed);
    changed.errors[2].message = message;
    assert.throws(() =>
      assertExpectedCleanupFailure(test, changed, attachment),
    );
  }
  const extra = structuredClone(observed);
  extra.errors.push({ message: 'Error: unrelated cleanup' });
  assert.throws(() => assertExpectedCleanupFailure(test, extra, attachment));
  assert.throws(() => assertExpectedCleanupFailure(test, observed, undefined));
  assert.throws(() =>
    assertExpectedCleanupFailure(test, observed, { observations: {} }),
  );
});

test('short assertion timings can exceed the historical limit without changing functional acceptance', () => {
  const current = summary();
  const baseline = {
    performanceThresholdMs: 6,
    inventory: { profiles: [{ id: 'profile' }] },
    sourceSha: 'a'.repeat(40),
  };
  current.results.find(
    (row) => row.observations?.samples,
  ).observations.samples[0].elapsedMs = 500;
  assertPublicNavigation(current);
  const diagnostics = shortModelTimingDiagnostics(current, baseline);
  assert.equal(diagnostics.status, 'diagnostic-only');
  assert.equal(diagnostics.samplesOverHistoricalThreshold, 1);
  assert.equal(diagnostics.maximumMs, 500);
  current.results[0].status = 'failed';
  assert.throws(() => assertPublicNavigation(current));
});
