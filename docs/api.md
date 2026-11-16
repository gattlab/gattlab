# Public API and operation semantics

Import only package entry points. Installed `dist/index.d.ts` declarations and
their reachable types are authoritative; this reference groups them by the
work a consumer performs and links to the declarations and usage examples.
Use the [quick start](quick-start.md) for your first test.

The native backend uses experimental Chromium CDP. It scripts subscriptions
and unsubscriptions, but notification payloads cannot be injected because the
protocol has no command for it. Each Chromium process owns one adapter and
admits one active lab; BrowserContexts do not isolate it.
[Compatibility](compatibility.md) separates the supported Playwright range from
the validated headless browser. [Protocol limitations](protocol-limitations.md)
describe the terminal lifecycle policy after document destruction.

## Fixture and adapter

Source declarations: [fixture exports](../packages/playwright/src/fixtures.ts),
[options](../packages/playwright/src/options.ts),
[facade and chooser](../packages/playwright/src/bluetooth-lab.ts).

`@gattlab/playwright` exports `test`, Playwright's unchanged `expect`, and
core `bytes`. `test` is Playwright Test extended with test-scoped `bluetooth`
and option `gattlab`; its ordinary test/describe/hooks/use/extend semantics are
those of the installed Playwright declarations. Those upstream functions are
delegated API, not separately implemented GattLab methods. Underscore fixture
keys and unexported runtime helpers are implementation details.

`BluetoothLab` is an abstract fixture-owned value, not a public constructor.
There is no public `attach`, `start`, `reset` or notification-payload method.
Receiving the fixture is inert; navigate its page to HTTPS or localhost before
the first backend-dependent operation. Pure model validation precedes startup.
Startup is shared and cannot be restarted after failure/disposal.

| Callable                        | Inputs and result                                                                                                 | Failure and deadline semantics                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BluetoothLab.createPeripheral` | `PeripheralDefinition` → `Promise<PeripheralHandle>`; validates/copies the model and registers identity/hierarchy | Invalid definition rejects with `BLUETOOTH_VALIDATION_FAILED`; duplicate address rejects with `BLUETOOTH_PERIPHERAL_ALREADY_REGISTERED`. Startup/capability/process-conflict/transport failures reject. One independent command budget C covers full registration and handle publication; unknown model effects at expiry invalidate the lab. |
| `createPreconnectedPeripheral`  | Same definition/result, with explicit system-known intent                                                         | Same failures; registration, preconnection and publication share one C. Does not itself establish an application connection.                                                                                                                                                                                                                  |
| `adapter.setState`              | `CentralState` (`absent`, `powered-off`, `powered-on`) → `Promise<void>`                                          | Invalid state rejects with `BLUETOOTH_VALIDATION_FAILED`; startup/stopped/transport errors reject. The independent command budget C bounds the state change. `getAvailability()` is true for powered-off as well as powered-on on this baseline.                                                                                              |
| `waitForDevicePrompt`           | No arguments → `Promise<DevicePrompt>`                                                                            | After awaited setup, arms the page listener synchronously. An entry fence uses C, then the full `promptTimeoutMs` arrival budget P; expiry permits one diagnostic C. Stopped/concurrent/startup failures reject. Only the fixture page's chooser is controlled.                                                                               |
| `dispose`                       | No arguments → `Promise<void>`                                                                                    | Idempotent; cancels pending waits and permanently invalidates live handles. Awaits cleanup before context/lease release; never closes the consumer's page/context/browser. Cleanup failures reject. `teardownTimeoutMs` bounds pending-work settlement, not every CDP cleanup command or total cleanup wall time.                             |

`GattLabFixtureOptions` defaults: `centralState: 'powered-on'`, operation,
prompt and teardown timeouts **5,000 ms**, diagnostic `historyLimit: 1,000`,
per-handle `operationHistoryLimit: 1,000`, `artifacts: 'retain-on-failure'`,
`payloadLogging: { mode: 'redacted' }`. Numeric options are positive safe
integers. Unknown options and invalid values fail fixture validation with
`BLUETOOTH_VALIDATION_FAILED`. No public method takes `TestInfo` or flushes
artifacts manually.

`GattLabArtifactRetention` is `off`, `retain-on-failure` or `always`.
`GattLabPayloadLoggingOptions` permits redacted byte lengths or
`{ mode: 'truncated', maxBytes: 16 }`; omitted truncated `maxBytes` defaults
to 64, maximum 4,096. No full-payload mode exists. An idle lab has no synthetic
artifact set. Unexpected failures retain available timeline, summary,
capabilities and device snapshots; successful unverified runs retain only
capabilities under the default policy. Early disposal does not discard later
failure diagnostics.

Each Chromium process permits one active lab. A second concurrent lab fails
with `BluetoothLabAlreadyActiveError`, including across BrowserContexts;
independent simultaneous adapters require separate browser processes/workers.
Cleanup attempts pending cancellation, domain disablement, session detachment
and diagnostic capture before releasing the process lease, including after
partial setup failure. Whole-domain disablement resets the model; individual
service/characteristic/descriptor removal is outside the 0.1 public contract.

The services in a peripheral definition are the single source of truth for its
GATT hierarchy and default chooser identity. `createPeripheral()` makes that
identity available without requiring scan advertisements. `advertise()` ensures
identity registration before sending scan data and records `identity-bootstrap`
separately from explicit preconnection intent. Scan UUIDs may describe a subset
of services; `knownServiceUuidsOverride` is only for controlled negative tests.

## Choose a peripheral

`DevicePrompt.devices` is the latest frozen candidate snapshot;
`DevicePromptCandidate` has `id` and `name`. Old snapshots remain unchanged.
`settled` becomes true after successful selection/cancellation. Candidate ids
match normalized peripheral addresses on the validated backend, while the
application's `BluetoothDevice.id` is a different opaque identifier. Empty or
duplicate display names cannot select a device.

| Callable     | Inputs and result                                                               | Failure and deadline semantics                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `select`     | `{ address: BluetoothAddress }`, normally a peripheral handle → `Promise<void>` | Invalid address rejects with validation error, no matching candidate with `BLUETOOTH_PROMPT_DEVICE_NOT_FOUND`. Stale/concurrent settlement and transport errors reject. |
| `selectById` | One current nonempty candidate id → `Promise<void>`                             | Advanced escape hatch; invalid/ambiguous id rejects with validation error, absent id with prompt-device-not-found.                                                      |
| `cancel`     | No arguments → `Promise<void>`                                                  | Cancels the application chooser, normally producing application `NotFoundError`. Stale/concurrent/transport failures reject.                                            |

The arrival deadline ends when a prompt arrives. Selection/cancellation have
a separate command budget C, including their liveness fence. An unrelated
settlement failure preserves its cause; a timeout does not prove the command
failed and does not authorize replay. Confirmed invalidation also closes
already obtained prompts. Arm the listener before the UI action; call
it after awaited setup so lazy startup cannot miss the chooser.

## Script and inspect GATT operations

Source declarations: [handles and records](../packages/playwright/src/handles.ts).
Every queue is FIFO for its own matching operation. One entry overrides one
response, then the default resumes. Payload input is copied when queued.
The fixture automatically responds to connection/discovery with success,
reads with copied `initialValue` (or empty bytes), and other attribute
operations with success. An empty public queue does not mean missing handling.

| Callable                                      | Inputs and result                                                     | Failure and deadline semantics                                                                                                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PeripheralHandle.characteristic`             | Service UUID and characteristic UUID strings → `CharacteristicHandle` | Synchronous normalization/lookup; malformed or absent path throws `BLUETOOTH_VALIDATION_FAILED`. Same characteristic UUID under another service is a separate path.                                                                                                    |
| `CharacteristicHandle.descriptor`             | Descriptor UUID → `DescriptorHandle`                                  | Same synchronous validation/lookup behavior.                                                                                                                                                                                                                           |
| `PeripheralHandle.advertise`                  | No arguments → `Promise<void>`                                        | Requires definition `advertisement`; absent scan data rejects with validation error. Starts no new chooser; send after a reconnect chooser opens. One independent command budget C bounds advertising.                                                                 |
| `PeripheralHandle.disconnect`                 | No arguments → `Promise<void>`                                        | Scripts native disconnection and rebuilds invalidated hierarchy before resolving. One C covers disconnect and hierarchy rehydration. Keeps domain handles and queued behavior on success; unknown partial effects at expiry invalidate the lab. No implicit reconnect. |
| `GattResponseQueue.queueSuccess`              | No arguments → `void`                                                 | Queue one connection/discovery success; synchronous stopped validation. No wait or deadline.                                                                                                                                                                           |
| `GattResponseQueue.queueError`                | `HciErrorName` → `void`                                               | Queue one HCI failure; invalid name throws validation error. Negative discovery cannot settle natively; see limitations.                                                                                                                                               |
| `ReadResponseQueue.queue`                     | `ByteSource` → `void`                                                 | Copy next read bytes; invalid payload throws validation error. No response is sent until a matching request.                                                                                                                                                           |
| `ReadResponseQueue.queueError`                | `AttErrorName` → `void`                                               | Queue one read failure; invalid name throws validation error.                                                                                                                                                                                                          |
| `AttributeResponseQueue.queueSuccess`         | No arguments → `void`                                                 | Queue one write/subscription/unsubscription success.                                                                                                                                                                                                                   |
| `AttributeResponseQueue.queueError`           | `AttErrorName` → `void`                                               | Queue one corresponding ATT failure; invalid name throws validation error.                                                                                                                                                                                             |
| `PeripheralHandle.operations`                 | No arguments → readonly connection/discovery records                  | Synchronous frozen newest-record snapshot with sequence, request, response, `responseSource`, `responseDelivery`.                                                                                                                                                      |
| `CharacteristicHandle.operations`             | No arguments → readonly characteristic records                        | Snapshot includes write intent/data and chosen ATT/read response; bytes are defensive copies.                                                                                                                                                                          |
| `DescriptorHandle.operations`                 | No arguments → readonly descriptor records                            | Same snapshot policy for descriptor reads/writes.                                                                                                                                                                                                                      |
| `CharacteristicHandle.expectRead`             | No arguments → `Promise<void>`                                        | First performs an entry fence under C, then resolves from a retained successful-read counter or waits the full `operationTimeoutMs` A. Failed reads do not satisfy it; expiry permits one diagnostic C.                                                                |
| `expectSubscription` / `expectUnsubscription` | No arguments → `Promise<void>`                                        | Same entry C, successful-counter/full A and optional diagnostic C policy for handshakes, not notification payloads.                                                                                                                                                    |
| `CharacteristicHandle.waitForWrite`           | No arguments → `Promise<CharacteristicWrite>`                         | Arm before action; retain events during entry C, then wait full A. Successful delivery resolves copied bytes and `writeType`; expiry permits one diagnostic C. Earlier writes are not replayed.                                                                        |
| `DescriptorHandle.waitForWrite`               | No arguments → `Promise<DescriptorWrite>`                             | Same next-write/deadline semantics, without characteristic write intent.                                                                                                                                                                                               |

Queue, lookup, advertising, disconnect, expectation and write-wait methods throw after disposal
synchronously with `BLUETOOTH_BACKEND_STOPPED`, even when their return type is
a promise. Registration rejects; journal snapshots and readonly
identity properties remain readable after disposal. Pending
expectations/writes are cancelled on disposal. Known invalidation takes precedence
over disposed checks and sticky counters; see the terminal context below. Each handle journal retains its
newest `operationHistoryLimit` records separately from diagnostic history.
Lifetime success counters survive eviction until disposal. Expectations never
install responses. Parallel write waiters observe the same next write; collect
a burst sequentially, arming each next wait before the next action.

`OperationResponseSource` distinguishes `queued`/`default`, and
`OperationResponseDelivery` distinguishes transport delivery `succeeded`/`failed`.
Delivery success is not application/peripheral acceptance: write-without-response
may resolve in the application before the journal update, even for a scripted
ATT failure. Characteristic writes preserve `default-deprecated`,
`with-response`, or `without-response` intent. The record/request/response
types are discriminated unions; they expose domain UUIDs/addresses, not CDP ids.

Complete typed fragment `handles-example.ts`; call it with a live handle and
the application action that produces its next write:

```ts
import { bytes, type PeripheralHandle } from '@gattlab/playwright';

export async function inspectNextWrite(
  sensor: PeripheralHandle,
  triggerWrite: () => Promise<void>,
) {
  const io = sensor.characteristic('180f', '2a19');
  io.reads.queue(bytes.hex('57'));
  io.writes.queueSuccess();
  const nextWrite = io.waitForWrite();
  await triggerWrite();
  const write = await nextWrite;
  const records = io.operations();
  return { write, records };
}
```

The [quick-start test](quick-start.md) covers the chooser and read journey; the
[Vanilla sample](../examples/vanilla-ts/README.md) adds writes through the UI.
The [Playwright package guide](../packages/playwright/README.md)
also shows reconnect ordering and configuration.

## Normalize bytes and models

Source declarations: [primitives](../packages/core/src/primitives.ts) and
[device model](../packages/core/src/device-model.ts).

| Callable                       | Inputs → result                                                                      | Synchronous errors; no deadline                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `normalizeBluetoothUuid`       | 4-digit, 8-digit or canonical 128-bit hex string → branded lowercase `BluetoothUuid` | `TypeError` for unsupported form; expands Bluetooth Base UUID. No service aliases, numeric input, `0x` prefix or trimming.  |
| `normalizeBluetoothAddress`    | Six colon-separated hex octets → branded uppercase `BluetoothAddress`                | `TypeError` for other shapes.                                                                                               |
| `bytes` / `BytesFactory` call  | `Uint8Array` or readonly octet array → fresh `Uint8Array`                            | Wrong types: `TypeError`; noninteger/out-of-range octets: `RangeError`.                                                     |
| `bytes.hex`                    | Contiguous or whitespace-separated complete hex octets → bytes                       | `TypeError` for incomplete/nonhex octets; empty string gives empty bytes.                                                   |
| `bytes.base64`                 | Canonical RFC 4648 string → bytes                                                    | `TypeError` for invalid alphabet, length, padding or nonzero padding bits.                                                  |
| `bytes.text`                   | String → UTF-8 bytes                                                                 | `TypeError` for wrong input or unpaired UTF-16 surrogate.                                                                   |
| `bytes.uint16le`               | Integer 0–65535 → two little-endian bytes                                            | Wrong type: `TypeError`; range/noninteger: `RangeError`.                                                                    |
| `validatePeripheralDefinition` | `PeripheralDefinition` → `ValidationResult<NormalizedPeripheral>`                    | Returns path-aware issues on failure, no partial normalized value; ordinary invalid models do not throw a validation error. |

Input definition types describe peripherals, services, characteristics,
descriptors, manufacturer data and optional advertisements/defaults.
`CharacteristicProperty` is drawn from frozen `characteristicProperties`.
Normalized types are immutable; byte getters return fresh copies. Omitted
arrays normalize to empty, services default to primary, and known/advertised
service UUID defaults derive from primary services. Explicit advertisement
fields override their fallback. UUIDs must be unique among siblings;
peripheral addresses are normalized independently and names may repeat.
Notify/indicate needs explicit descriptor `2902`; omission returns
`missing-cccd-descriptor`. Core may normalize secondary services; Chromium's
capability check still rejects unsupported secondary construction.

Complete example `model-example.ts`:

```ts
import {
  bytes,
  normalizeBluetoothAddress,
  normalizeBluetoothUuid,
  validatePeripheralDefinition,
  type PeripheralDefinition,
} from '@gattlab/core';

const definition = {
  address: normalizeBluetoothAddress('aa:bb:cc:dd:ee:ff'),
  name: 'Battery sensor',
  advertisement: { rssi: -45 },
  services: [
    {
      uuid: normalizeBluetoothUuid('180f'),
      characteristics: [
        {
          uuid: '2a19',
          properties: ['read', 'notify'],
          initialValue: bytes([87]),
          descriptors: [{ uuid: '2902', initialValue: bytes.uint16le(0) }],
        },
      ],
    },
  ],
} satisfies PeripheralDefinition;
const result = validatePeripheralDefinition(definition);
if (!result.success) throw new Error(JSON.stringify(result.issues));
export const peripheral = result.value;
export const encodings = [bytes.base64('Vw=='), bytes.text('sensor')];
```

## Stable errors and diagnostic context

Source declarations: [errors](../packages/core/src/errors.ts).
`GattLabError` has a protected constructor, stable `code`, immutable copied
`context`, and original `cause`. All nine public subclasses accept
`(message: string, options?: GattLabErrorOptions)` synchronously and set their
corresponding code below. Invalid message or unsupported/cyclic/nonplain
context throws `TypeError`; constructors add no deadline or transport action.
`DiagnosticValue` admits JSON-like values; summarize payloads instead of
putting typed arrays into diagnostic context.

| Constructor                                 | Code and trigger                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `BluetoothValidationError`                  | `BLUETOOTH_VALIDATION_FAILED`: invalid public input/model/path                   |
| `BluetoothTimeoutError`                     | `BLUETOOTH_TIMEOUT`: named diagnostic deadline expired                           |
| `BluetoothCancelledError`                   | `BLUETOOTH_CANCELLED`: explicit/disposal cancellation                            |
| `BluetoothBackendStoppedError`              | `BLUETOOTH_BACKEND_STOPPED`: use after stop begins or terminal lab invalidation  |
| `BluetoothConcurrentOperationError`         | `BLUETOOTH_CONCURRENT_OPERATION`: overlapping chooser/response settlement        |
| `BluetoothLabAlreadyActiveError`            | `BLUETOOTH_LAB_ALREADY_ACTIVE`: one process already leased                       |
| `BluetoothPeripheralAlreadyRegisteredError` | `BLUETOOTH_PERIPHERAL_ALREADY_REGISTERED`: duplicate normalized address          |
| `PromptDeviceNotFoundError`                 | `BLUETOOTH_PROMPT_DEVICE_NOT_FOUND`: requested candidate absent                  |
| `BluetoothCapabilityUnsupportedError`       | `BLUETOOTH_CAPABILITY_UNSUPPORTED`: missing engine/environment/native capability |

`GattLabErrorCode` derives from `gattLabErrorCodes`; `AttErrorName` and
`HciErrorName` derive from frozen `attErrorNames`/`hciErrorNames`.
`InjectedProtocolError` preserves scripting intent. These names cannot be
recovered from application DOMExceptions. Keep application outcomes and lab
journals as separate assertions. Conflict context names `in-process-lease`
or `cdp-domain-conflict`, `leaseScope: 'browser-process'` and remediation
`use-separate-browser-process`; the CDP-detected error preserves transport cause.

### Terminal lab context

The first immutable CDP-owned terminal record closes the lab with
`BluetoothBackendStoppedError` and `BLUETOOTH_BACKEND_STOPPED`. Its copied,
frozen context has `lifecycleState: 'invalidated'`, `reason`, `operation`,
`operationLayer`, `detectedBy`, `boundary` and `remediation: 'new-test-fixture'`.
It omits core's cleanup `state`. The current attempted method names its own
error; a composed facade call keeps its facade name through nested CDP work.

| Reason                  | Detection and retained cause                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter-lost`          | `command-rejection` or `liveness-check`; retains the first `CdpTransportError` and direct protocol cause.                                                            |
| `fixture-page-closed`   | `fixture-page-close`; no fabricated protocol cause.                                                                                                                  |
| `model-outcome-unknown` | `model-operation-aborted`; a model deadline/cancellation after issued or partial effects retains that original timeout/cancellation. It does not prove adapter loss. |

`boundary` is `fixture-document-changed`, `fixture-page-closed` or `unobserved`;
a recorded document change is diagnostic context, not proof of cause. Later
operations report the first terminal record during stopping and after cleanup.
Ordinary disposal that wins first keeps its existing disposed/stopped contract.
Explicit cancellation remains the caller's primary error, even when partial
model effects also invalidate future use. `stop()`/`dispose()` remain idempotent;
identity properties and journal snapshots remain inspectable.

A registration racing document destruction may receive no reply from Chromium
and take up to the **30,000 ms command watchdog** to invalidate with
`model-outcome-unknown` / `model-operation-aborted`. Its cause is the original
`BluetoothTimeoutError` with `BLUETOOTH_TIMEOUT`, `deadlineKind: 'command'`,
`timeoutPhase: 'operation'` and the effective command deadline; it is not proof
of adapter loss. Direct CDP factory consumers can shorten C with `commandDeadlineMs`;
the Playwright facade exposes no command-budget option and keeps C = 30,000 ms.

`operationLayer` is `playwright` or `cdp`. Exact method names are used:
`createPeripheral`, `createPreconnectedPeripheral`, `setState`,
`waitForDevicePrompt`, `advertise`, `disconnect`, `characteristic`, `descriptor`,
`expectRead`, `expectSubscription`, `expectUnsubscription`, `waitForWrite`,
`queue`, `queueSuccess`, `queueError`, `select`, `selectById`, `cancel`;
direct backend names additionally include `setCentralState`, `addPeripheral`,
`simulateAdvertisement`, `onEvent`, and `respondToGattOperation`, `respondToCharacteristicOperation`,
`respondToDescriptorOperation`.
Automatic facade delivery uses its response method with the Playwright layer.
No raw protocol command name is a consumer operation.

### Independent command and application deadlines

Let C be `commandDeadlineMs`, A be the handle/pending-GATT application wait,
and P be prompt arrival. Playwright uses **C = 30,000 ms** without a new option;
`operationTimeoutMs` and `promptTimeoutMs` keep their existing A/P meanings.
Direct CDP `operationDeadlineMs` retains pending-GATT semantics.

The 30,000 ms default is deliberately far above how long these commands take
in practice; it bounds a command that Chromium never answers, not normal
latency. Assertion and prompt options cannot change C.

| Started operation                                        | Maximum phases absent earlier settlement/cancellation                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| State, advertisement, response send or prompt settlement | One C, including queue/fence time, plus at most one diagnostic C.                                                                              |
| Model registration/preconnection/disconnect              | One shared C across all commands and final commit/publication; expiry after effects immediately invalidates, without a health-check extension. |
| Chooser or asynchronous handle wait                      | Entry C, then the full A/P, then at most one diagnostic C. Listeners arm before actions and retain events during entry.                        |
| Received pending GATT request                            | Existing A plus at most one diagnostic C; response delivery never resets A.                                                                    |
| Expired entry fence                                      | C only; no recursive diagnostic check.                                                                                                         |

A mutation beginning with an emulation command detects loss through that command
and avoids a redundant entry fence. Every hierarchy send and commit remains
gated. Automatic response C includes time queued behind earlier responses.
An unanswered underlying state/fence command keeps serialization ownership
until its actual result settles or teardown ends tracking. A later check can
expire before sending, yielding `unconfirmed`, `centralStateBlocked: true` and
`dispose-lab`; it cannot issue a stale state write. A late acknowledged state
updates the committed state only while the lab remains usable.

Timeouts retain `BluetoothTimeoutError`/`BLUETOOTH_TIMEOUT`, with copied/frozen
`operation`, `operationLayer`, `timeoutPhase` (`operation`/`entry-check`),
`deadlineKind` (`command`/`application-operation`/`prompt`), original `deadlineMs`,
independent `checkDeadlineMs`, `detection`, `centralStateBlocked` and `remediation`.
Detection is `not-checked`, `live`, `check-failed`, `check-timed-out` or
`unconfirmed`. Only a recognized loss selects the terminal error; timeout alone
proves neither adapter loss nor failed command effects. Remediation is
`dispose-lab` for a blocked check, otherwise `inspect-operation`, which does
not authorize retry.

CDP exports structural type `CdpCommandTimeout`; it adds no error class.
A failed/timed-out diagnostic check exposes optional **non-enumerable, frozen**
`deadlineCheck: CdpDeadlineCheckEvidence`, carrying `timeoutPhase: 'deadline-check'`,
`deadlineKind: 'command'`, C as `deadlineMs`, its detection and actual `cause`.
The primary timeout keeps its original phase, budget and cause chain; the
secondary check does not replace them. This evidence is also retained across
the Playwright boundary. Inspect it explicitly: JSON enumeration omits it.

Raw transport sends, standalone registries/handlers/prompt controllers,
capability probing, whole startup and existing teardown are excluded from the
new started-command budget. Teardown's separate deadline still bounds final
pending-work settlement, not every cleanup command or total cleanup wall time.
See the [consumer navigation example](../packages/playwright/README.md#document-changes-and-command-timeouts).

## Core backend lifecycle, cancellation and timeline

Source declarations: [backend contracts](../packages/core/src/backend.ts),
[timeline](../packages/core/src/timeline.ts). These are advanced building blocks;
normal Playwright consumers use the fixture's lifecycle.

| Callable                              | Inputs/result                                                   | Failure and deadline semantics                                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createCancellationController`        | No arguments → `CancellationController` with `signal`           | No deadline; one-shot cancellation.                                                                                                                          |
| `CancellationController.cancel`       | No arguments → `void`                                           | Synchronously marks cancelled and notifies listeners once.                                                                                                   |
| `CancellationSignal.throwIfCancelled` | No arguments → `void`                                           | Synchronously throws `BLUETOOTH_CANCELLED` after cancellation.                                                                                               |
| `CancellationSignal.onCancelled`      | Callback → idempotent unsubscribe                               | Late subscriber is called synchronously; invalid callback throws `TypeError`.                                                                                |
| `snapshotBluetoothCapabilities`       | `BluetoothCapabilities` → copied/frozen snapshot                | No probing or validation policy; domains/operations copied.                                                                                                  |
| `copyBackendBluetoothEvent`           | Discriminated event → frozen copied envelope/references         | Each write recipient owns its own mutable byte copy.                                                                                                         |
| `new PeripheralAddressRegistry`       | No arguments → registry                                         | Starts empty; `size` includes pending reservations.                                                                                                          |
| `register`                            | Normalized address, asynchronous mutation → `Promise<void>`     | Reserves before await; duplicate rejects before mutation, failed mutation rolls back and propagates original cause. No registry deadline.                    |
| `clear`                               | No arguments → `void`                                           | Clears reservations, not transport devices.                                                                                                                  |
| `new BackendLifecycleController`      | No arguments → started controller                               | No automatic backend creation.                                                                                                                               |
| `assertStarted`                       | Operation label → `void`                                        | Synchronous stopped error unless started.                                                                                                                    |
| `onEvent`                             | Callback → idempotent unsubscribe                               | Synchronous `TypeError` for invalid listener, stopped error after stop begins.                                                                               |
| `emit`                                | Event → boolean                                                 | Copies per listener; false after stopping; callback exceptions propagate synchronously.                                                                      |
| `stop`                                | Async cleanup callback → shared `Promise<void>`                 | Clears listeners and begins stopping immediately; finally becomes stopped even on cleanup rejection. Invalid callback throws `TypeError`; no added deadline. |
| `BackendCleanupStep.run`              | No arguments → `Promise<void>`                                  | Caller supplies cleanup; rejection is retained by the helper.                                                                                                |
| `runBestEffortBackendCleanup`         | Ordered steps → frozen failures with step names/original causes | Awaits every step, including after failure; does not throw an aggregate itself or add a deadline.                                                            |
| `MonotonicClock.now`                  | No arguments → finite nondecreasing milliseconds                | Injected caller contract, not wall time.                                                                                                                     |
| `createBluetoothTimeline`             | Positive safe-integer `limit`, `clock` → timeline               | Invalid limit: `RangeError`; invalid/nonfinite clock: `TypeError`.                                                                                           |
| `BluetoothTimeline.append`            | `TimelineEventInput` → immutable timed/sequenced event          | Closed: stopped error; regressing clock: `RangeError`. Retains newest `limit` records.                                                                       |
| `snapshot`                            | No arguments → frozen records                                   | Usable after close; no deadline.                                                                                                                             |
| `close`                               | No arguments → `void`                                           | Idempotent; call after final cleanup diagnostics/snapshot. Later append throws.                                                                              |

`BluetoothAutomationBackendFactory.start(BackendStartOptions)` creates a
backend with central state and optional structural cancellation. The core
interface adds no deadline. `BackendCallOptions` carries cancellation;
concrete backend implementations define operation validation and timeout policy.
`BluetoothCapabilities` separates domain/operation support and unsupported
native notification/secondary-service capabilities. Entity references use
normalized address/UUID paths; event/response unions carry synthetic
`operationId` tokens valid only while pending in that backend.
`centralStates`, `timelineCategories` and `timelineStatuses` are frozen vocabularies;
their corresponding type aliases derive from those values.

Complete `lifecycle-example.ts` (pure core, no browser):

```ts
import {
  BackendLifecycleController,
  PeripheralAddressRegistry,
  createBluetoothTimeline,
  createCancellationController,
  normalizeBluetoothAddress,
  runBestEffortBackendCleanup,
} from '@gattlab/core';

const cancellation = createCancellationController();
const unsubscribe = cancellation.signal.onCancelled(() => undefined);
const addresses = new PeripheralAddressRegistry();
await addresses.register(
  normalizeBluetoothAddress('00:11:22:33:44:55'),
  async () => {
    cancellation.signal.throwIfCancelled();
  },
);
const lifecycle = new BackendLifecycleController();
let tick = 0;
const timeline = createBluetoothTimeline({
  limit: 2,
  clock: { now: () => tick },
});
timeline.append({
  category: 'lifecycle',
  type: 'started',
  status: 'succeeded',
});
tick = 1;
await lifecycle.stop(async () => {
  const failures = await runBestEffortBackendCleanup([
    {
      name: 'addresses',
      async run() {
        addresses.clear();
      },
    },
  ]);
  if (failures.length > 0) throw failures[0]?.cause;
});
timeline.append({
  category: 'lifecycle',
  type: 'stopped',
  status: 'succeeded',
});
export const snapshot = timeline.snapshot();
timeline.close();
unsubscribe();
cancellation.cancel();
```

## Advanced CDP integration

Source declarations: [factory/backend](../packages/cdp/src/backend.ts),
[transport](../packages/cdp/src/transport.ts),
[probe](../packages/cdp/src/capability-probe.ts),
[prompt](../packages/cdp/src/device-prompt-controller.ts),
[numeric mappings](../packages/cdp/src/error-codes.ts),
[terminal/timeout evidence](../packages/cdp/src/lab-lifecycle.ts).
These APIs require explicit session, response and browser-process ownership.
They do not inherit the fixture's successful-default response policy.

| Callable                                    | Inputs/result                                                                                                             | Failure and deadline semantics                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `new CdpTransport` / `createCdpTransport`   | Target `browser`/`page`, structural `CdpSessionLike` → typed transport                                                    | Registers close listener synchronously; no lease or deadline.                                                                                                                                          |
| `CdpSessionLike.send/on/off/detach`         | Raw command/event/listener/session operations                                                                             | Structural callbacks supplied by the host; return/reject behavior belongs to that session.                                                                                                             |
| `CdpTransport.send`                         | Target-typed command and pinned parameters → typed result promise                                                         | Wrong target rejects `TypeError`; command/closure rejects `CdpTransportError`. No command deadline.                                                                                                    |
| `on`                                        | Target-typed event/listener → idempotent unsubscribe                                                                      | Wrong target/closed session throws synchronously; callback errors are not normalized.                                                                                                                  |
| `detach`                                    | No arguments → shared promise                                                                                             | Removes subscriptions; underlying detach rejection propagates; marks closed in finally. No deadline.                                                                                                   |
| `new CdpTransportError`                     | `{ kind, target, method, cause? }` → ordinary Error                                                                       | `kind` is `command-failed`/`session-closed`; has no domain `code`.                                                                                                                                     |
| `new CdpCapabilityProbe`                    | `CdpCapabilityProbeOptions` → probe                                                                                       | Empty browser name/missing inspector throws `TypeError`. Caller owns inactive transports.                                                                                                              |
| `probe`                                     | No arguments → immutable capabilities                                                                                     | Temporarily enables/disables only owned required domains; typed capability/conflict errors reject. Does not acquire a lease or detach sessions; no deadline.                                           |
| `new CdpBluetoothBackendFactory`            | Owned browser/page transports, inspector, timeline/clock/scheduler, deadlines, lease release and optional flush → factory | Invalid callbacks/name throw `TypeError`, invalid deadlines `RangeError`; caller must already own the process lease.                                                                                   |
| `start`                                     | `{ centralState, cancellation? }` → `Promise<CdpBluetoothBackend>`                                                        | One attempt, including failures; reuse rejects validation error, invalid state `TypeError`, startup/cancellation/capability/transport failures reject and unwind. No whole-start deadline.             |
| `setCentralState`                           | State and optional cancellation → `Promise<void>`                                                                         | Invalid state throws synchronously; backend/transport/cancellation failures reject. One finite C bounds started state work; an unresolved raw send retains state serialization.                        |
| `addPeripheral`                             | Normalized definition, optional cancellation → `Promise<void>`                                                            | Duplicate/secondary capability/transport failures reject; partial hierarchy failure invalidates registration state.                                                                                    |
| `simulateAdvertisement`                     | Registered normalized peripheral → `Promise<void>`                                                                        | Unknown address/missing advertisement reject `TypeError`; registered definition is authoritative. One finite C bounds started state work; an unresolved raw send retains state serialization.          |
| `createPreconnectedPeripheral`              | Registered normalized peripheral → `Promise<void>`                                                                        | Unknown address rejects; system-known intent, not a GATT connection.                                                                                                                                   |
| `disconnect`                                | Normalized registered address → `Promise<void>`                                                                           | Cancels pending address operations, scripts disconnect and rehydrates hierarchy. Invalid/unknown address rejects validation error; no automatic advertisement.                                         |
| `respondToGattOperation`                    | Matching `GattOperationResponse` → `Promise<void>`                                                                        | Correlates pending id/type and HCI response; stale/mismatched/concurrent/deadline failures reject. Unsuccessful discovery remains behind diagnostic deadline.                                          |
| `respondToCharacteristicOperation`          | Matching ATT response/read bytes → `Promise<void>`                                                                        | Validates/copies bytes and correlation; stale references/invalid names reject before mutation.                                                                                                         |
| `respondToDescriptorOperation`              | Matching descriptor ATT response/read bytes → `Promise<void>`                                                             | Same correlation/payload validation; non-read success has no payload.                                                                                                                                  |
| `onEvent`                                   | Domain callback → unsubscribe                                                                                             | Invalid callback/stopped state throws synchronously. Consumer must respond to received GATT/attribute events; no default responses.                                                                    |
| `waitForDevicePrompt`                       | Optional arrival `deadlineMs` and integration `operationLayer` → prompt promise                                           | Synchronous arming; entry C precedes full P; optional one diagnostic C. `operationLayer` defaults to `cdp` and is not a Playwright option.                                                             |
| `CdpDevicePrompt.select/selectById/cancel`  | Normalized address/current id/no input, optional `BackendCallOptions` → promise                                           | Same selection semantics as facade; type-only export, constructed by controller, no public constructor import. One C including entry fencing; supplied scope options preserve a composed outer budget. |
| `assertUsable`                              | Method name, optional layer → `void`                                                                                      | Rejects from retained terminal evidence before generic stopped guards; defaults to CDP layer.                                                                                                          |
| `onInvalidated`                             | Record listener → idempotent unsubscribe                                                                                  | Synchronous copied/frozen first `CdpLabInvalidation`; late subscriber receives the retained record. Cause remains separate from diagnostic fields.                                                     |
| `noteFixtureDocumentChanged`                | No arguments → `void`                                                                                                     | Records an observed fixture document boundary only; does not invalidate or send.                                                                                                                       |
| `invalidateFixturePage`                     | Optional layer → `void`                                                                                                   | Records fixture closure through the terminal path; disposal that won first remains authoritative.                                                                                                      |
| `withCommandBudget`                         | Method, layer, async callback, optional call options → `Promise<T>`                                                       | One C covers queueing/composed work. Forward callback-supplied options to nested calls and call its `assertCommit()` immediately before publication.                                                   |
| `checkLiveness`                             | Method, optional layer → `Promise<void>`                                                                                  | Finite serialized entry C reapplies committed state; never resets/reconstructs.                                                                                                                        |
| `diagnoseTimeout`                           | Method, layer, original timeout, optional application/prompt kind → `Promise<never>`                                      | At most one independent C; rejects with enriched original timeout or confirmed terminal evidence.                                                                                                      |
| `stop`                                      | No arguments → shared promise                                                                                             | Cancels waits, removes handlers, disables/detaches, settles work, flushes, releases lease and closes timeline. Best effort; cleanup failures aggregate.                                                |
| `CdpBackendDeadlineScheduler.schedule`      | Positive milliseconds, callback → owned deadline                                                                          | Callback must not run before schedule returns.                                                                                                                                                         |
| Returned deadline `cancel`                  | No arguments → `void`                                                                                                     | Cancels owned callback, does not itself settle a native operation.                                                                                                                                     |
| Environment inspector callbacks             | No arguments → `Promise<WebBluetoothEnvironment>`                                                                         | Supply `secureContext` and `navigatorBluetooth`; rejection becomes capability diagnostics.                                                                                                             |
| `flushArtifacts` / `releaseLease` callbacks | Timeline snapshot/no arguments → `Promise<void>`                                                                          | Awaited during teardown; failure is retained while remaining cleanup is attempted.                                                                                                                     |
| `attErrorCode` / `hciErrorCode`             | Typed scripting name → numeric code                                                                                       | Synchronous frozen-table lookup, no runtime validation; invalid untyped names yield undefined.                                                                                                         |

`attErrorCodes`, `hciErrorCodes` and `protocolSuccessCode` (`0x00`) are CDP-owned
numeric maps. `BluetoothCdpCommand`, `BluetoothCdpEvent`, parameter/result and
payload helper types select the pinned protocol declarations for `CdpTarget`.
Their existence is not a runtime capability proof.

Factory `commandDeadlineMs?: number` is a positive finite safe integer,
validated during construction before startup effects. Zero, negative, fractional,
NaN, infinite and unsafe integer values reject with RangeError. Omission selects 30,000 ms.
All listed started mutations, backend-issued prompt settlements and integration
fences use it. Nested calls forward the same `BackendCallOptions` object supplied
by `withCommandBudget`; constructing new options would discard the owned scope.
The TSDoc contract is in [backend.ts](../packages/cdp/src/backend.ts) and
[deadline evidence types](../packages/cdp/src/lab-lifecycle.ts).
`operationDeadlineMs` remains the received pending-GATT A;
`promptDeadlineMs` and optional per-wait `deadlineMs` remain P.
`WaitForDevicePromptOptions.operationLayer` and optional prompt call options
support integration; they add no Playwright option. Startup, raw/standalone
components and teardown retain the exclusions described above.

Complete typed advanced example `cdp-example.ts`. The caller supplies a live
secure page and an **already acquired** external browser-process lease; calling
this beside a fixture-owned lab in the same process is invalid. It registers
no application GATT work and adds no response defaults:

```ts
import type { Browser, Page } from '@playwright/test';
import { createBluetoothTimeline } from '@gattlab/core';
import {
  CdpBluetoothBackendFactory,
  createCdpTransport,
  type CdpBluetoothBackendFactoryOptions,
} from '@gattlab/cdp';

export async function inspectOwnedAdapter(
  browser: Browser,
  page: Page,
  releaseLease: () => Promise<void>,
  commandDeadlineMs?: number,
) {
  const clock = { now: () => performance.now() };
  const timeline = createBluetoothTimeline({ limit: 200, clock });
  const browserTransport = createCdpTransport(
    'browser',
    await browser.newBrowserCDPSession(),
  );
  const pageTransport = createCdpTransport(
    'page',
    await page.context().newCDPSession(page),
  );
  const options: CdpBluetoothBackendFactoryOptions = {
    browserName: 'chromium',
    browserTransport,
    pageTransport,
    timeline,
    clock,
    inspectWebBluetoothEnvironment: () =>
      page.evaluate(() => ({
        secureContext: globalThis.isSecureContext,
        navigatorBluetooth: 'bluetooth' in navigator,
      })),
    deadlineScheduler: {
      schedule(ms, callback) {
        const timer = setTimeout(callback, ms);
        return {
          cancel() {
            clearTimeout(timer);
          },
        };
      },
    },
    operationDeadlineMs: 5_000,
    promptDeadlineMs: 5_000,
    teardownDeadlineMs: 5_000,
    releaseLease,
  };
  // Choose omission for the package default, or supply e.g. 60_000 for
  // a larger direct-CDP workload. Construct exactly one factory/owner.
  const factory = new CdpBluetoothBackendFactory(
    commandDeadlineMs === undefined
      ? options
      : { ...options, commandDeadlineMs },
  );
  const backend = await factory.start({ centralState: 'powered-on' });
  try {
    await backend.setCentralState('powered-off');
    return backend.capabilities;
  } finally {
    await backend.stop();
  }
}
```

If session acquisition or factory construction fails before ownership reaches
the factory, the host must detach acquired sessions and release its lease.
Once start is attempted, factory startup failure owns its unwind. A standalone
`CdpCapabilityProbe` is a separate reversible operation on inactive sessions;
the [CDP package guide](../packages/cdp/README.md) explains what it checks. Do not run a probe inside an already active backend.

Complete `probe-example.ts`, on a browser process with no active backend:

```ts
import type { Browser, Page } from '@playwright/test';
import { CdpCapabilityProbe, createCdpTransport } from '@gattlab/cdp';

export async function probeInactiveBrowser(browser: Browser, page: Page) {
  const browserTransport = createCdpTransport(
    'browser',
    await browser.newBrowserCDPSession(),
  );
  try {
    const pageTransport = createCdpTransport(
      'page',
      await page.context().newCDPSession(page),
    );
    try {
      const identity = await browserTransport.send('Browser.getVersion');
      const capabilities = await new CdpCapabilityProbe({
        browserName: 'chromium',
        browserTransport,
        pageTransport,
        inspectWebBluetoothEnvironment: () =>
          page.evaluate(() => ({
            secureContext: globalThis.isSecureContext,
            navigatorBluetooth: 'bluetooth' in navigator,
          })),
      }).probe();
      return { identity, capabilities };
    } finally {
      await pageTransport.detach();
    }
  } finally {
    await browserTransport.detach();
  }
}
```

Complete `responses-example.ts` is a deliberately small success-only policy,
not a substitute for your application's scripts. Install the subscription
before triggering native work, retain response failures, await all in-flight
responses before teardown and unsubscribe. Empty read data below is an
explicit policy choice; callers can substitute their defined values.

```ts
import { bytes, type BackendBluetoothEvent } from '@gattlab/core';
import {
  attErrorCode,
  hciErrorCode,
  type CdpBluetoothBackend,
} from '@gattlab/cdp';

export async function respondSuccessfully(
  backend: CdpBluetoothBackend,
  event: BackendBluetoothEvent,
): Promise<void> {
  const identity = { operationId: event.operationId, type: event.type };
  switch (event.kind) {
    case 'gatt-operation':
      await backend.respondToGattOperation({
        operationId: event.operationId,
        type: event.type,
        result: 'success',
      });
      break;
    case 'characteristic-operation':
      await backend.respondToCharacteristicOperation(
        event.type === 'read'
          ? {
              operationId: event.operationId,
              type: 'read',
              result: 'success',
              data: bytes([]),
            }
          : {
              operationId: event.operationId,
              type: event.type,
              result: 'success',
            },
      );
      break;
    case 'descriptor-operation':
      await backend.respondToDescriptorOperation(
        event.type === 'read'
          ? {
              operationId: event.operationId,
              type: 'read',
              result: 'success',
              data: bytes([]),
            }
          : {
              operationId: identity.operationId,
              type: 'write',
              result: 'success',
            },
      );
      break;
  }
}
export const injectedCodes = {
  readFailure: attErrorCode('read-not-permitted'),
  connectionFailure: hciErrorCode('connection-timeout'),
};
```
