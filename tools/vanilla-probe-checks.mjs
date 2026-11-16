import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const requiredVersions = ['Version 6.0.3', 'Version 5.9.3'];

export function assertConsumerSpecCoverage(files, consumerRoot) {
  for (const spec of ['vanilla-app.spec.ts', 'vanilla-regression.spec.ts']) {
    assert.ok(
      files.includes(resolve(consumerRoot, 'tests', spec)),
      `The installed consumer strict check must include ${spec}.`,
    );
  }
}

export function assertCompilerCoverage(checks) {
  for (const target of ['sample', 'consumer']) {
    const versions = checks
      .filter((check) => check.target === target)
      .map((check) => check.version);
    assert.deepEqual(
      versions.toSorted(),
      requiredVersions.toSorted(),
      `Both compiler versions must complete the ${target} strict check.`,
    );
  }
  return checks
    .filter((check) => check.target === 'sample')
    .map((check) => check.version.replace('Version ', ''));
}

export async function assertServerProcessesExited(consumerRoot, expectedCount) {
  const pids = await readServerPids(consumerRoot);
  assert.equal(
    pids.length,
    expectedCount,
    'Every sample server must register its PID before serving tests.',
  );
  const live = pids.filter(isAlive);
  assert.deepEqual(
    live,
    [],
    `Leaked Vanilla application servers: ${live.join(', ')}`,
  );
}

export async function cleanupServerProcesses(consumerRoot) {
  const pids = await readServerPids(consumerRoot);
  for (const pid of new Set(pids)) {
    if (!isAlive(pid)) continue;
    signal(pid, 'SIGTERM');
    try {
      await waitForExit(pid);
    } catch {
      signal(pid, 'SIGKILL');
      await waitForExit(pid);
    }
  }
}

async function readServerPids(consumerRoot) {
  let source;
  try {
    source = await readFile(resolve(consumerRoot, 'server-pids.jsonl'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return source
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const pid = JSON.parse(line);
      assert.ok(
        Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid,
        `Invalid sample server PID: ${line}`,
      );
      return pid;
    });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function signal(pid, value) {
  try {
    process.kill(pid, value);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function waitForExit(pid) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(poll);
      reject(
        new Error(
          `Sample server PID ${String(pid)} did not exit within 5000 ms.`,
        ),
      );
    }, 5_000);
    const poll = setInterval(() => {
      try {
        if (isAlive(pid)) return;
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      } catch (error) {
        clearInterval(poll);
        clearTimeout(deadline);
        reject(error);
      }
    }, 20);
  });
}

// Shared by the Vanilla and Blazor probes: one intentional application assertion
// failure must stay primary and carry GattLab's four redacted artifacts.
export async function inspectFailureReport(report, consumerRoot, marker) {
  const specs = collectSpecs(report.suites ?? []);
  assert.equal(specs.length, 1, 'Expected one intentional-failure spec.');
  const results = specs.flatMap((spec) =>
    (spec.tests ?? []).flatMap((test) => test.results ?? []),
  );
  assert.equal(results.length, 1, 'Expected one intentional-failure result.');
  const result = results[0];
  assert.equal(result.status, 'failed');
  assert.equal(
    result.errors?.length,
    1,
    'Diagnostic attachment must not add or replace the application assertion error.',
  );
  const errorText = (result.errors ?? [])
    .map((error) => `${error.message ?? ''}\n${error.stack ?? ''}`)
    .join('\n');
  assert.ok(
    errorText.includes(marker),
    `The intentional assertion (${marker}) must stay the primary error.`,
  );
  assert.match(errorText, /Locator:[\s\S]*Expected:[\s\S]*Received:/u);

  const attachments = new Map(
    (result.attachments ?? []).map((attachment) => [
      attachment.name,
      attachment,
    ]),
  );
  assert.deepEqual(
    [...attachments.keys()]
      .filter((name) => name.startsWith('gattlab-'))
      .sort(),
    [
      'gattlab-capabilities.json',
      'gattlab-devices.json',
      'gattlab-diagnostics.json',
      'gattlab-summary.md',
    ],
  );

  const diagnostics = JSON.parse(
    await attachmentText(
      attachments.get('gattlab-diagnostics.json'),
      consumerRoot,
    ),
  );
  assert.equal(diagnostics.schemaVersion, 1);
  assert.ok(diagnostics.timelines.length > 0);
  assert.ok(
    diagnostics.timelines.some((timeline) => timeline.events.length > 0),
  );

  const summary = await attachmentText(
    attachments.get('gattlab-summary.md'),
    consumerRoot,
  );
  assert.match(summary, /Test outcome: failed/u);
  assert.match(summary, /Compatibility: validated/u);
  assert.match(summary, /Troubleshooting hints/u);

  const devicesText = await attachmentText(
    attachments.get('gattlab-devices.json'),
    consumerRoot,
  );
  const devices = JSON.parse(devicesText);
  assert.equal(devices.schemaVersion, 1);
  assert.deepEqual(devices.payloadLogging, { mode: 'redacted' });
  assert.equal(devices.devices.length, 1);
  assert.match(devicesText, /"byteLength": 4/u);
  assert.doesNotMatch(
    devicesText,
    /previewHex|de ad be ef|222\s*,\s*173\s*,\s*190\s*,\s*239/iu,
  );

  const capabilities = JSON.parse(
    await attachmentText(
      attachments.get('gattlab-capabilities.json'),
      consumerRoot,
    ),
  );
  assert.equal(capabilities.schemaVersion, 1);
  assert.equal(capabilities.compatibility.status, 'validated');
  assert.equal(
    capabilities.capabilities.browserProduct,
    'HeadlessChrome/159.0.8154.6',
  );
}

function collectSpecs(suites) {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []),
    ...collectSpecs(suite.suites ?? []),
  ]);
}

async function attachmentText(attachment, consumerRoot) {
  assert.notEqual(attachment, undefined, 'Expected diagnostic attachment.');
  if (attachment.body !== undefined) {
    return Buffer.from(attachment.body, 'base64').toString('utf8');
  }
  assert.equal(typeof attachment.path, 'string');
  return readFile(resolve(consumerRoot, attachment.path), 'utf8');
}
