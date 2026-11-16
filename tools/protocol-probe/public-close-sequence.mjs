import assert from 'node:assert/strict';

export const MAX_CLOSE_STEPS = 3;
export const MODEL_COMMAND_WATCHDOG_MS = 30_000;

export function isDestructiveRegistration(row) {
  return (
    ['N2', 'N3', 'N4', 'N7', 'N9'].includes(row.group) &&
    ['goto', 'reload', 'other-origin', 'blank', 'close'].includes(row.action) &&
    row.level !== 'U0' &&
    row.retainedFixture !== true &&
    !(row.subject === 'fixture' && row.action === 'close')
  );
}

// A reported uncertainty is never evidence that the adapter was lost.
export function assertModelTimeoutEvidence(evidence) {
  assert.deepEqual(evidence, {
    causeType: 'BluetoothTimeoutError',
    code: 'BLUETOOTH_TIMEOUT',
    operation: 'createPeripheral',
    operationLayer: 'playwright',
    deadlineKind: 'command',
    timeoutPhase: 'operation',
    deadlineMs: MODEL_COMMAND_WATCHDOG_MS,
    checkDeadlineMs: MODEL_COMMAND_WATCHDOG_MS,
    detection: 'not-checked',
    centralStateBlocked: false,
    remediation: 'inspect-operation',
    causeRetained: true,
  });
}

export function assertModelCommandAbort(cause, expected, types) {
  assert.ok(cause instanceof types.stopped);
  assert.equal(cause.code, 'BLUETOOTH_BACKEND_STOPPED');
  const context = cause.context;
  assert.ok(Object.isFrozen(context));
  assert.equal('state' in context, false);
  for (const [key, value] of Object.entries({
    reason: 'model-outcome-unknown',
    lifecycleState: 'invalidated',
    operation: expected.operation,
    operationLayer: 'playwright',
    detectedBy: 'model-operation-aborted',
    boundary: expected.boundary,
    remediation: 'new-test-fixture',
  }))
    assert.equal(context[key], value);
  const timeout = cause.cause;
  assert.ok(timeout instanceof types.timeout);
  assert.ok(Object.isFrozen(timeout.context));
  if (expected.retainedCause !== undefined)
    assert.equal(timeout, expected.retainedCause);
  const evidence = {
    causeType: timeout.name,
    code: timeout.code,
    operation: timeout.context.operation,
    operationLayer: timeout.context.operationLayer,
    deadlineKind: timeout.context.deadlineKind,
    timeoutPhase: timeout.context.timeoutPhase,
    deadlineMs: timeout.context.deadlineMs,
    checkDeadlineMs: timeout.context.checkDeadlineMs,
    detection: timeout.context.detection,
    centralStateBlocked: timeout.context.centralStateBlocked,
    remediation: timeout.context.remediation,
    causeRetained: true,
  };
  assertModelTimeoutEvidence(evidence);
  return { timeout, evidence };
}

// Successive public operations, never retries of a failed operation.
export async function observePublicClose(
  register,
  verifyRegistration,
  verifyLoss,
) {
  for (let step = 0; step < MAX_CLOSE_STEPS; step += 1) {
    let value;
    try {
      value = await register(step);
    } catch (cause) {
      verifyLoss(cause);
      return {
        outcome: 'invalidated',
        steps: step + 1,
        verifiedRegistrations: step,
        cause,
      };
    }
    verifyRegistration(value, step);
  }
  return {
    outcome: 'continued',
    steps: MAX_CLOSE_STEPS,
    verifiedRegistrations: MAX_CLOSE_STEPS,
  };
}
