# `@gattlab/playwright`

Playwright Test integration for GattLab. The package exports its custom
`test`, Playwright's unchanged `expect`, the core `bytes` helper, and the
fixture-owned `BluetoothLab` facade from one import location.

```sh
npm install --save-dev @gattlab/playwright@beta @playwright/test
```

The [quick start](https://github.com/gattlab/gattlab/blob/main/docs/quick-start.md) builds a minimal application and
a first runnable test. See [API semantics](https://github.com/gattlab/gattlab/blob/main/docs/api.md),
[troubleshooting](https://github.com/gattlab/gattlab/blob/main/docs/troubleshooting.md),
[compatibility](https://github.com/gattlab/gattlab/blob/main/docs/compatibility.md) and the terminal
[document-destruction boundary](https://github.com/gattlab/gattlab/blob/main/docs/protocol-limitations.md#document-destruction-and-process-reuse).

```ts
import { bytes, expect, test } from '@gattlab/playwright';

test('reads a battery level', async ({ page, bluetooth }) => {
  await page.goto('/');

  const sensor = await bluetooth.createPeripheral({
    address: '09:09:09:09:09:09',
    name: 'Battery Sensor',
    services: [
      {
        uuid: '180f',
        characteristics: [{ uuid: '2a19', properties: ['read'] }],
      },
    ],
  });
  const battery = sensor.characteristic('180f', '2a19');
  battery.reads.queue(bytes([87]));

  const promptPromise = bluetooth.waitForDevicePrompt();
  await page.getByRole('button', { name: 'Connect' }).click();
  await (await promptPromise).select(sensor);

  await expect(page.getByTestId('battery')).toHaveText('87%');
  await battery.expectRead();
});
```

The `bluetooth` fixture is dependency driven, not automatic. Importing the
package or receiving the facade has no browser-side effect. Its first adapter
or chooser operation starts the runtime lazily, so navigate the
consumer page to HTTPS or an accepted localhost origin first. GattLab never
navigates or replaces the consumer's page.

Configure the same fixture through the sole `gattlab` option key:

```ts
import { defineConfig } from '@playwright/test';
import type { GattLabOptionFixtures } from '@gattlab/playwright';

export default defineConfig<GattLabOptionFixtures>({
  use: {
    gattlab: {
      centralState: 'powered-on',
      operationTimeoutMs: 5_000,
      promptTimeoutMs: 5_000,
      teardownTimeoutMs: 5_000,
      historyLimit: 1_000,
      operationHistoryLimit: 1_000,
      artifacts: 'retain-on-failure',
      payloadLogging: { mode: 'redacted' },
    },
  },
});
```

Every numeric value must be a positive safe integer. `artifacts` accepts
`off`, `retain-on-failure`, or `always`. `payloadLogging` defaults to
`{ mode: 'redacted' }`; the only opt-in is a bounded prefix such as
`{ mode: 'truncated', maxBytes: 16 }` (maximum 4,096 bytes). Full payload
logging is not available.
Runtime adapter-state validation occurs before lazy startup.
`createPeripheral()` validates the full static model before starting the
runtime, registers chooser identity and the GATT hierarchy, and returns
transport-neutral handles. Call
`waitForDevicePrompt()` after an awaited setup operation such as
`createPeripheral()` or `adapter.setState()`. With the shared backend ready,
the method arms the real DeviceAccess listener synchronously before returning
its promise. Its prompt exposes frozen candidate snapshots,
`select(peripheral)` by normalized address, `selectById(id)` as the
advanced escape hatch, and `cancel()`; it never selects by display name.

Peripheral handles use both service and characteristic UUIDs for lookup.
Their `connection` and `discovery` queues override the default successful
response once per queued entry. Use `connection.holdNext()` to observe the
application's waiting state and call `resume()` when the test is ready to
deliver success. See [hold a connection response](https://github.com/gattlab/gattlab/blob/main/docs/api.md#hold-a-connection-response).
Characteristic handles expose `reads`,
`writes`, `subscriptions`, and `unsubscriptions`; descriptor handles expose
`reads` and `writes`. Reads default to the definition's copied `initialValue`
(or empty bytes), and the other attribute operations default to success.
`advertise()` sends optional scan data, `disconnect()` uses native GATT
disconnection, and `createPreconnectedPeripheral()` records explicit
preconnection intent. Native subscription handshakes are supported, but the
current Chromium backend cannot inject later notification payloads.

Chromium discards its internal GATT hierarchy after a scripted disconnection.
GattLab rebuilds that hierarchy before `disconnect()` resolves, so the same
public handle and its queued behavior remain usable. If the application opens
a new chooser, define `advertisement`, open the chooser first, and advertise
into that live scan before selecting the handle:

```ts
const reconnectPromptPromise = bluetooth.waitForDevicePrompt();
await page.getByRole('button', { name: 'Reconnect' }).click();
const reconnectPrompt = await reconnectPromptPromise;
await sensor.advertise();
await reconnectPrompt.select(sensor);
```

Advertising before the new chooser opens is not persistent on the validated
Chromium baseline. See the [reconnect lifecycle](https://github.com/gattlab/gattlab/blob/main/docs/protocol-limitations.md#scripted-disconnection-and-reconnection).

Every handle's `operations()` returns a frozen, transport-neutral snapshot
with defensive payload copies. `operationHistoryLimit` bounds each handle
independently from the diagnostic `historyLimit`; lifetime counters survive
detail eviction. `expectRead()`, `expectSubscription()`, and
`expectUnsubscription()` first perform a state-preserving entry fence, then use
the retained counter or full application wait. Old counters cannot bypass
known invalidation. `waitForWrite()` must be armed
before the application action and uses `operationTimeoutMs`, as do the
expectations. Queue methods only install responses; expectation methods never
send or queue one.

Normal tests rely on automatic fixture teardown. `bluetooth.dispose()` is
available for early cleanup, is idempotent, does not close the consumer's page,
context, or browser, and permanently prevents that fixture-owned lab from
restarting. There is intentionally no public `start()`, `attach()`, raw backend,
or runtime-controller API.

On an unexpected test outcome, the fixture automatically attaches a bounded,
payload-free `gattlab-diagnostics.json` timeline and an actionable
`gattlab-summary.md`. Successful capability probing adds
`gattlab-capabilities.json`; registered peripherals add a sanitized
`gattlab-devices.json`. Device payloads contain only byte lengths by default,
or the explicitly bounded hexadecimal prefix selected by `payloadLogging`.
Capture happens before the browser-process lease moves, while attachment
happens after disposal; an early `bluetooth.dispose()` therefore does not lose
later failure diagnostics. `always` retains the same set for a used successful
lab, while `off` disables attachments. No policy manufactures artifacts for an
idle lab. Consumers never pass `TestInfo`, flush diagnostics, or manage
artifact paths.

The validated runtime tuple is Playwright 1.65.1 with its bundled
`HeadlessChrome/159.0.8154.6`, CDP 1.3, and `headless: true`; Linux additionally
uses `--enable-features=WebBluetooth`. A different capability-complete tuple
continues as `unverified` instead of failing solely on version comparison. The
mismatch is recorded in the timeline and a Playwright report annotation. On a
successful test, the default policy attaches only `gattlab-capabilities.json`;
timeline, summary, and device artifacts are retained for an unexpected failure
or when `artifacts: 'always'` is selected. Non-Chromium engines and missing
required capabilities remain hard errors.

The package peer range is `>=1.65.0 <2.0.0`, so a newer Playwright 1.x release
installs without a peer conflict; only the tuple above is validated, and other
versions run as `unverified`. Its public declarations
are tested from installed tarballs with TypeScript 5.9.3 and the repository
compiler, TypeScript 6.0.3; this is not a compatibility claim for older
TypeScript 5.x releases. Only the exports documented in this README are public.
Underscore-prefixed fixture internals that JavaScript destructuring can observe
are implementation details and are not supported consumer imports.

## Document changes and command timeouts

Navigation, reload or closure of a document that used Web Bluetooth can remove
Chromium's process-wide emulation, including another page/context. GattLab
preserves usable hash/history, unused-document and retained-observer controls;
page navigation alone never triggers invalidation. After recognized loss,
active calls reject with `BluetoothBackendStoppedError` and frozen context
`reason: 'adapter-lost'`, `lifecycleState: 'invalidated'`, the exact method name,
`operationLayer: 'playwright'` and `remediation: 'new-test-fixture'`. The first
transport/protocol cause survives cleanup and later calls. Fixture closure uses
`fixture-page-closed`; model registration/preconnection/disconnect abandoned
after effects use `model-outcome-unknown` with their original timeout/cancellation
cause, even on a live adapter. No repair, restart or replay is provided.

The independent command default is **30,000 ms** (C); there is no new Playwright
option. `operationTimeoutMs` remains handle/pending-GATT A, and `promptTimeoutMs`
remains chooser arrival P. Registration/preconnection/disconnect and publication
share one C. Non-model commands and prompt settlement allow C plus at most one
diagnostic C; model uncertainty after effects stops immediately at C. Chooser
and handle waits arm synchronously, retain events during entry C, then start the
full A/P and allow at most one diagnostic C. A short assertion option cannot
shorten registration or entry/check commands.

An unresolved underlying state/fence command retains serialization until its
actual result settles or cleanup ends tracking. Later checks can expire before
sending: detection `unconfirmed`, `centralStateBlocked: true`, remediation
`dispose-lab`. No new health send happened; this does not prove the prior state
change failed or the adapter was lost. Other timeout outcomes use
`inspect-operation`, without authorizing retry. Optional non-enumerable frozen
`deadlineCheck` retains the bounded secondary check's C, phase `deadline-check`
and actual cause; the primary timeout keeps its original A/P/C and cause chain.
Raw/standalone CDP components, whole startup and existing teardown remain outside
this started-command policy.

Complete typed `navigation-example.ts`; it reports structured advice and
rethrows the original error. Normal fixture teardown still owns cleanup:

```ts
import {
  BluetoothBackendStoppedError,
  BluetoothTimeoutError,
} from '@gattlab/core';
import type { CdpCommandTimeout } from '@gattlab/cdp';
import { test } from '@gattlab/playwright';

export function labFailureAdvice(error: unknown): string {
  if (
    error instanceof BluetoothBackendStoppedError &&
    error.context['lifecycleState'] === 'invalidated'
  ) {
    return `Lab ended (${String(error.context['reason'])}); put the next Bluetooth journey in a new test fixture after cleanup.`;
  }
  if (error instanceof BluetoothTimeoutError) {
    const timeout = error as CdpCommandTimeout;
    if (timeout.context['centralStateBlocked'] === true) {
      return 'No health command was sent; loss and the prior state outcome remain unconfirmed. Finish or dispose this lab; do not send another state write.';
    }
    return `Inspect ${String(timeout.context['operation'])} and its bounded check evidence (${String(timeout.deadlineCheck?.detection ?? timeout.context['detection'])}); do not replay an unknown outcome.`;
  }
  return 'Inspect the original failure and cause.';
}

test('retains a navigation failure', async ({ page, bluetooth }) => {
  await page.goto('/'); // secure application origin configured by the test
  const sensor = await bluetooth.createPeripheral({
    address: '09:09:09:09:09:09',
    name: 'Navigation sensor',
    advertisement: { rssi: -42 },
    services: [
      {
        uuid: '180f',
        characteristics: [{ uuid: '2a19', properties: ['read'] }],
      },
    ],
  });
  await page.evaluate(async () => {
    const native = (
      navigator as unknown as {
        bluetooth: { getAvailability(): Promise<boolean> };
      }
    ).bluetooth;
    await native.getAvailability();
  });
  await page.reload();
  try {
    await sensor.advertise();
  } catch (error) {
    console.info(labFailureAdvice(error));
    throw error;
  }
});
```

A new document can still report `getAvailability() === true` after emulation
loss. Independent application calls may reach a non-emulated host adapter;
physical-device access was not demonstrated. Invalidation blocks GattLab-owned
chooser actions and responses, not independent application calls.
Identity properties and frozen journal snapshots remain inspectable; active
lookups, queues, old prompts and expectations reject. Disposal remains
idempotent and reportable cleanup failures, including closed-page session
failures, do not erase terminal context.

See the
[command deadline contract](https://github.com/gattlab/gattlab/blob/main/docs/api.md#independent-command-and-application-deadlines).

## Errors

A second lab in one Chromium process throws
`BluetoothLabAlreadyActiveError`. Its immutable context always recommends a
separate browser process and identifies how the conflict was detected:
`in-process-lease` is the zero-session fast path for two fixtures using the
same Playwright `Browser` object; `cdp-domain-conflict` means another client of
a shared browser server already owns the process-wide domain. The latter is
common with `connectOptions`, preserves the CDP transport failure as `cause`,
and never disables the other client's lab during unwind.

## Parallel tests and isolation

Map one Playwright worker to one locally launched Chromium process when tests
need independent simultaneous labs. Workers may reuse their process
sequentially after fixture teardown, but one process can own only one active
lab at a time. `connectOptions` points every worker at the same remote browser
process, so those workers must serialize GattLab use or expect the typed
conflict above; separate `Browser` wrapper objects do not create separate
adapters.

A second `BrowserContext` or page in the owning process sees the shared fake
adapter (`navigator.bluetooth.getAvailability()` remains true), but GattLab's
DeviceAccess session observes only the chooser opened by the fixture page.
Calling `requestDevice()` from another page therefore stays outside the lab's
chooser control, and `bluetooth.waitForDevicePrompt()` ends at its configured
`BluetoothTimeoutError` deadline after its entry fence and at most one diagnostic check, instead of hanging
until the test timeout. Adapter loss can instead select the terminal error.

Duplicate peripheral names are valid and are never an isolation or selection
key. Chromium exposes empty chooser display names on the validated baseline;
`prompt.select(peripheral)` selects the current candidate by the peripheral's
normalized address.

Development coverage is split deliberately: Vitest owns
`test/**/*.test.ts`, while the real pinned-Chromium fixture contract lives in
the regular `e2e/**/*.spec.ts` suite and the separate isolation config.
Run them with `pnpm test:playwright` and
`pnpm test:playwright:isolation`. Linux Chromium is launched with
`--enable-features=WebBluetooth`.

## License

[Apache-2.0](https://github.com/gattlab/gattlab/blob/main/LICENSE).
