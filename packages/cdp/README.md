# `@gattlab/cdp`

Typed Chromium CDP implementation details for GattLab, published on npm as a
prerelease under the `beta` tag. Application tests normally consume the
`@gattlab/playwright` facade rather than instantiate these components.

See the [consumer quick start](https://github.com/gattlab/gattlab/blob/main/docs/quick-start.md),
[advanced API semantics](https://github.com/gattlab/gattlab/blob/main/docs/api.md#advanced-cdp-integration),
[troubleshooting](https://github.com/gattlab/gattlab/blob/main/docs/troubleshooting.md) and
[compatibility matrix](https://github.com/gattlab/gattlab/blob/main/docs/compatibility.md). Notification payloads
cannot be injected; the protocol has no command for it. One active lab owns the adapter per Chromium process. Recognized
document-related emulation loss permanently invalidates that lab; see the
[terminal contract](https://github.com/gattlab/gattlab/blob/main/docs/api.md#terminal-lab-context).

## Production backend

`CdpBluetoothBackendFactory` composes the capability probe, entity and pending
registries, all operation handlers, the DeviceAccess prompt controller, and the
core lifecycle contract over one browser-session/page-session pair. The
Playwright integration owns session creation and its process-keyed lease; it
passes a required `releaseLease` callback so the backend can prove that the
lease moves only after protocol cleanup and artifact flushing have been
attempted.

Startup returns only a fully enabled backend. A probe, enable, handler-install,
or cancellation failure preserves the primary error while best-effort unwind
disables every domain it acquired, detaches both sessions, flushes the current
timeline snapshot, releases the lease, and closes the timeline. One factory
instance is single-use because its session pair is single-use.

The pinned process-wide domain conflict is the one exception to generic
capability/startup classification. When the browser rejects an enable because
another Playwright client already owns the domain, both the capability-probe
position and the later backend-enable position return
`BluetoothLabAlreadyActiveError` with `detection: 'cdp-domain-conflict'`.
Cleanup detaches this client's sessions but never disables a domain that this
client did not enable. Other enable failures retain their existing capability
or transport error and attempted-cleanup behavior.

`stop()` is shared and idempotent. It cuts off public events synchronously,
cancels the pending registry, disposes the prompt controller, removes protocol
listeners, attempts `DeviceAccess.disable` and `BluetoothEmulation.disable`,
detaches both sessions, and then waits for both protocol-response mutations and
ordinary backend calls under the configured teardown deadline. Deadline expiry
and every cleanup failure are recorded before artifact flush, lease release,
and the final `timeline.close()`. Cleanup continues after failures; the shared
stop promise rejects with an `AggregateError` only after the lease has been
released and the timeline closed. Underlying issued mutations remain observed after public settlement. A late
acknowledgement cannot publish a model, deliver a successful handle record or
reactivate an invalidated lab; inability to append to a closed timeline cannot
replace the already selected primary result.

The pinned Chromium contract establishes `disable → enable` as the
whole-lab entity reset. The backend's real Chromium contract separately checks
that teardown actually sends `BluetoothEmulation.disable` before detaching the
browser session and that the next sequential backend sees an empty chooser.

`disconnect(address)` cancels every pending operation for that peripheral
before sending the simulated disconnection command. A response mutation that
finishes after disconnect or teardown remains terminally cancelled and records
`operation-late-completion`; it cannot restore the earlier public result.

Advertisement entries explicitly disclose Chromium's omitted-field workaround
without recording scan payloads. `appearanceSubstituted` and
`txPowerSubstituted` identify the supplied zeroes, while
`txPowerSubstitutionApplicationVisible` makes clear that an omitted transmit
power can become an application-visible 0 dBm value.

## Started-command budget and terminal usability

`CdpBluetoothBackendFactoryOptions.commandDeadlineMs?: number` is an independent
positive finite safe integer, validated at construction before startup sends.
Omission uses **30,000 ms**. `operationDeadlineMs` remains the pending-GATT
application wait A and `promptDeadlineMs` remains prompt arrival P. Playwright
omits the new field and exposes no new option.

The default is far above how long these commands normally take; it bounds a
command that Chromium never answers. See the
[command deadline contract](https://github.com/gattlab/gattlab/blob/main/docs/api.md#independent-command-and-application-deadlines).

Started registration/preconnection/disconnect use one C across nested hierarchy
sends, queueing and commit/publication. Deadline/cancellation after effects
invalidates the whole model with `model-outcome-unknown`; no replay or per-entity
repair is attempted. Before-effects expiry/cancellation leaves the model usable.
Non-model state/advertisement/response/prompt commands use C plus at most one
diagnostic C. Chooser and asynchronous handle waits use entry C, then full P/A,
then at most one diagnostic C. Received pending requests retain A plus an optional
diagnostic C; response-send work never resets that original A. Raw sends,
standalone components, startup/probe and existing teardown are excluded.

The CDP owner recognizes only the pinned missing-binding rejection for an owned
browser emulation command while started. Unknown/unrelated transport failures
retain their causes. A liveness fence reapplies the last acknowledged central
state and serializes with underlying state sends through actual protocol
settlement, even after public timeout/cancellation. It never enables, resets or
rebuilds the adapter. A blocked later check sends nothing and expires with
`unconfirmed`/`centralStateBlocked: true`/`dispose-lab`; disposal ends tracking.
Timeout alone does not prove loss or failed state effects.

The first copied/frozen `CdpLabInvalidation` is retained during and after cleanup.
`BluetoothBackendStoppedError` context names the attempted method/layer and
`lifecycleState: 'invalidated'`, `reason`, `detectedBy`, `boundary`,
`remediation: 'new-test-fixture'`; it omits core cleanup `state`. Reasons are
`adapter-lost` (first transport/protocol cause), `fixture-page-closed` (no invented
protocol cause), and `model-outcome-unknown` (original timeout/cancellation cause).
Explicit cancellation remains primary. Ordinary disposal that won first keeps
its existing stopped contract. Pending work settles once; inspection and
idempotent stop remain available.

Advanced lifecycle integration methods on the returned backend are documented
and linked to TSDoc in [the API table](https://github.com/gattlab/gattlab/blob/main/docs/api.md#advanced-cdp-integration):

| Method                                                    | Host contract                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `assertUsable(operation, layer?)`                         | Guard terminal usability before active work; layer defaults to `cdp`.                                                                      |
| `onInvalidated(listener)`                                 | Receive immutable first record synchronously, including the stored record for a late subscriber; returns unsubscribe.                      |
| `noteFixtureDocumentChanged()`                            | Supply observed main-document boundary context only; never infer loss from navigation.                                                     |
| `invalidateFixturePage(layer?)`                           | Signal owned page closure without fabricating a protocol rejection.                                                                        |
| `withCommandBudget(operation, layer, callback, options?)` | Share C across composed work. Forward the callback's options object to nested calls; call `assertCommit()` immediately before publication. |
| `checkLiveness(operation, layer?)`                        | Finite serialized state-preserving entry check.                                                                                            |
| `diagnoseTimeout(operation, layer, timeout, kind?)`       | One bounded check; reject with enriched original timeout or terminal error.                                                                |

`WaitForDevicePromptOptions.operationLayer` is an advanced integration field,
defaulting to `cdp`. Backend-issued prompt `select`, `selectById`, and `cancel`
accept optional `BackendCallOptions` so a facade can forward its composed scope.
Neither addition introduces a Playwright option or changes prompt arrival.

`CdpCommandTimeout` is a structural enrichment of `BluetoothTimeoutError`, not
a new class. Optional `deadlineCheck` is non-enumerable and frozen;
`CdpDeadlineCheckEvidence` carries phase `deadline-check`, command budget C,
failed/timed-out/unconfirmed detection and actual check cause. The primary
phase, original A/P/C and cause chain remain intact. See
[timeout diagnostics](https://github.com/gattlab/gattlab/blob/main/docs/troubleshooting.md#deadlines-and-teardown).

For an already owned inactive session pair, choose omission or an explicit
larger direct workload budget using the same options. This helper constructs
one factory, not two competing owners:

```ts
import {
  CdpBluetoothBackendFactory,
  type CdpBluetoothBackendFactoryOptions,
} from '@gattlab/cdp';

export function ownedFactory(
  options: CdpBluetoothBackendFactoryOptions,
  commandDeadlineMs?: number,
): CdpBluetoothBackendFactory {
  return new CdpBluetoothBackendFactory(
    commandDeadlineMs === undefined
      ? options
      : { ...options, commandDeadlineMs },
  );
}
// ownedFactory(options) uses the package default when the field is omitted.
// ownedFactory(options, 60_000) selects an explicit finite override instead.
// Choose one for each owned session pair/process lease.
```

The [complete owned-session example](https://github.com/gattlab/gattlab/blob/main/docs/api.md#advanced-cdp-integration)
shows startup and finally-stop without manually restarting a lab.

## Capability probe

Run the probe before enabling a lab. It checks the Playwright browser engine,
reads the browser/protocol identity, inspects the page's Web Bluetooth
environment, and temporarily enables both required CDP domains on their proven
targets. Every successfully enabled domain is disabled before `probe()`
resolves.

A complete typed example with session ownership and finally-detach is in
[the advanced API guide](https://github.com/gattlab/gattlab/blob/main/docs/api.md#advanced-cdp-integration).

The Playwright CDP error surface does not expose JSON-RPC error codes. A failed
domain command is therefore reported as failure of the required capability set
with its original `cause`; the implementation never infers method support from
error-message wording. Individual operation flags are grounded in the pinned
real-browser contracts recorded by the repository.

On Linux, launch Chromium with `--enable-features=WebBluetooth`. The probe also
requires the inspected page to use a secure context such as HTTPS or localhost.

See the repository [compatibility baseline](https://github.com/gattlab/gattlab/blob/main/docs/compatibility.md) and
[protocol limitations](https://github.com/gattlab/gattlab/blob/main/docs/protocol-limitations.md).

## Pending operation registry

The internal pending registry gives every received GATT, characteristic, or
descriptor operation a backend-local synthetic `operationId`. Its correlation
key uses the stable entity reference plus operation type; no Chromium entity id
crosses into core events or timeline data.

Only one unresolved operation may occupy a key. A second same-entity,
same-type event is rejected because Chromium supplies no request id that could
distinguish its response. Different operation types remain independent. Every
response is checked for a known, still-pending id and matching operation family
and type before its protocol mutation callback can run.

The registry receives an explicit deadline scheduler, whose callback must run
after `schedule()` returns, and records received, pending, response, timeout,
cancellation, failure, and late-completion states in the core timeline. An
unsuccessful discovery response intentionally remains pending until its
diagnostic deadline because Chromium accepts the protocol response without
settling the application's discovery promise on the pinned baseline. The
resulting timeout identifies the delivered error response and this known
limitation without requiring callers to predict it at registration time.

A response callback that finishes after timeout or cancellation is recorded as
late and cannot replace the terminal result. Lifecycle owners must cancel
pending operations before closing the timeline so every in-flight protocol
mutation can record that late completion. `settled()` has no built-in timeout:
teardown must first attempt domain disablement and CDP-session detachment so
in-flight sends can reject, then await `settled()` under an explicit teardown
deadline whose expiry is recorded before the timeline closes.

Operation handlers own the concrete CDP event and response mappings. Teardown
cancels the registry, attempts domain disablement and session detachment,
awaits `settled()` under that bounded teardown contract, then closes the
timeline and releases the browser-process lease.

## GATT operation handler

The internal GATT handler maps browser-session connection and discovery events
to frozen core events for peripherals already present in the entity registry.
It normalizes the protocol address, registers the operation before delivery,
and routes malformed addresses, unknown peripherals, invalid operation types,
and same-key concurrency failures to an explicit error listener. Mapping
failures are also recorded as payload-free `gatt-event-rejected` timeline
entries. If the listener throws, the newly registered operation is cancelled
with reason `listener-failed`, releasing its correlation key before the error
reaches the error listener.

Responses are resolved through the pending-operation registry before any CDP
command is sent. The validated pending event supplies the stable peripheral
address; success maps to protocol code `0x00`, while stable core HCI error names
map through the package's pinned error-code table. Unknown HCI names fail
runtime validation before registry settlement or protocol mutation.
Unsuccessful discovery keeps the registry's diagnostic-deadline behavior: the
response promise rejects with the resulting `BluetoothTimeoutError` rather
than reporting a protocol success that Chromium never makes
application-visible. The internal handler only validates and sends a simulated
disconnection; the production backend wraps it with per-peripheral pending
cancellation before protocol mutation.

## Characteristic operation handler

The internal characteristic handler resolves Chromium's opaque characteristic
id through the entity registry before emitting a stable reference. It maps
reads, writes, subscription, and unsubscription handshakes through the shared
pending-operation registry. Rejected inbound shapes are recorded as payload-
free `characteristic-event-rejected` timeline entries, and listener failures
cancel the newly registered operation before reaching the error listener.

Characteristic write data is decoded from canonical Base64 into owned bytes.
The deprecated `writeValue()` path maps to stable `default-deprecated`
semantics, alongside `with-response` and `without-response`; raw CDP write-type
names do not cross the package boundary. Successful read bytes are validated
and encoded back to canonical Base64, while non-read successes omit data.
Stable ATT error names are runtime-validated before registry settlement and map
through the pinned package table.

Responses resolve their stable characteristic reference again immediately
before protocol mutation. If an entity-registry failure invalidated the
hierarchy in the meantime, the response fails as a stale reference and no CDP
response command is sent.

Subscription and unsubscription remain response handshakes only. The handler
does not provide native notification payload injection.
Chromium requires the emulated characteristic to define the Client
Characteristic Configuration descriptor (`0x2902`); without it,
`startNotifications()` fails natively and no characteristic-operation event is
emitted. Core validation rejects `notify` or `indicate` definitions that omit
that descriptor.

## Descriptor operation handler

The internal descriptor handler resolves Chromium's opaque descriptor id to a
stable address, service, characteristic, and descriptor reference before
delivery. The entity registry maintains parallel reference-keyed indexes for
characteristics and descriptors, so response correlation can revalidate a
pending reference without scanning the registered hierarchy. Entity
invalidation clears the opaque-id and stable-reference indexes together; a
later response then fails as a stale reference before any CDP command.

Descriptor write data crosses the protocol boundary only as strict canonical
Base64 and is delivered as owned bytes. Successful read bytes are validated
and encoded back to canonical Base64, successful writes omit data, and stable
ATT error names are runtime-validated before registry settlement. Malformed
events produce payload-free `descriptor-event-rejected` timeline entries, and
a failing listener cancels its newly registered operation before the error is
routed to the handler's error listener.

## Device prompt controller

The standalone controller retains its arrival deadline and has no added command
budget; the factory installs the lifecycle/budget hooks described above. The
internal page-session prompt controller installs
`DeviceAccess.deviceRequestPrompted` synchronously inside
`waitForDevicePrompt()` before returning its promise. Only one wait or
unsettled prompt is permitted at a time. A diagnostic deadline rejects an
unfulfilled wait with `BluetoothTimeoutError` containing elapsed time, central
state, known peripheral addresses, advertisement count, at most ten timeline
summaries, and the Web Bluetooth user-gesture reminder.
If the injected clock or diagnostic-state provider fails while the deadline is
being handled, the wait still rejects with `BluetoothTimeoutError`; unavailable
fields become `null` or an empty list, `diagnosticsUnavailable` identifies the
failed diagnostic step, and the timeline marks the degraded timeout.

Chromium may emit more than one event for the same open prompt while its
candidate list grows. The controller keeps the listener until selection,
cancellation, or disposal and replaces the handle's `devices` value with each
new frozen snapshot; a previously read array and its entries remain frozen and
unchanged. Malformed first events reject the wait, while malformed or foreign
updates leave the last valid snapshot intact and produce payload-free timeline
diagnostics.

Address selection matches a normalized peripheral address to exactly one
candidate id. Empty and duplicate display names
are never considered. Zero matches throw `PromptDeviceNotFoundError` before a
protocol command; `selectById()` is the explicit advanced escape hatch. A
successful select or cancel settles the handle once and removes its listener.
A standalone command rejection can leave the prompt open under its caller
policy. Backend-issued prompts additionally apply terminal guards, entry fencing
and C; a timeout or unknown outcome does not authorize replay. Timeline entries include candidate counts and selection
mode but omit prompt ids, candidate ids, names, and complete protocol payloads.

## License

[Apache-2.0](https://github.com/gattlab/gattlab/blob/main/LICENSE).
