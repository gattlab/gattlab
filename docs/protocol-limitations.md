# Protocol and lifecycle limitations

GattLab drives Chromium's experimental `BluetoothEmulation` and `DeviceAccess`
DevTools protocol domains. This page lists where that layer limits what a test
can do and how GattLab behaves at those limits. Statements about "the pinned
browser" are covered by the repository's real-browser tests on Playwright
1.65.1 with Chromium 159.0.8154.6; see [compatibility](compatibility.md).

Read it together with the [quick start](quick-start.md),
[API semantics](api.md) and [troubleshooting](troubleshooting.md).

## Error names and what the application sees

Tests script errors by stable ATT and HCI names such as `read-not-permitted`.
The CDP backend maps them to Chromium's numeric codes; core exports no numeric
protocol codes.

The mapping is one-way. The application only sees the `DOMException` that Web
Bluetooth exposes, and that exception does not carry the ATT or HCI code. On
the pinned browser, scripted `read-not-permitted` and `unlikely-error`
characteristic read responses both reach the application as a generic
`NotSupportedError`, and a `read-not-permitted` descriptor read does the same.

Assert the outcome your application shows, and read the exact scripted error
from the handle's operation journal. A timeline entry records what GattLab
injected; it is not evidence that the browser passed the same detail on.

## Adapter availability and powered-off chooser

On the pinned browser, `getAvailability()` returns `true` for both
`powered-on` and `powered-off`, and `false` for `absent`. Availability does not
mean the adapter is powered on.

With the adapter `powered-off`, `requestDevice()` still opens a chooser that
lists registered peripherals. Cancelling it rejects the application's request
with `NotFoundError`; Chromium reports no adapter error. Switching back to
`powered-on` allows a normal connection again.

## CDP command errors

Playwright's `CDPSession.send()` does not expose the JSON-RPC error code when
Chromium rejects a command. The error message is not a stable contract, so
GattLab never infers capability support or an error category from its wording.
The transport recognizes a closed session from the session's `close` event and
reports anything else as a generic command failure that keeps the original
cause.

## Capability probe

Before a lab starts, the probe checks the page's Web Bluetooth environment and
enables, then disables, the two required protocol domains. Because the
protocol error code is unavailable, any failure counts as failure of the whole
required set, with the original cause attached for diagnostics.

The per-operation flags in the capability snapshot describe what the
repository's tests confirmed on the pinned browser. The probe does not invoke
every operation against your page. On another browser version, an experimental
command can change without the probe noticing.

## Device chooser identity and updates

In Chromium's emulation, chooser entries have empty display names and their
candidate ids equal the peripherals' normalized Bluetooth addresses. Duplicate
peripheral names are therefore valid but can never be used for selection.
After selection the application receives its own opaque `BluetoothDevice.id`;
GattLab never presents that id as a Bluetooth address.

Chromium can send several `deviceRequestPrompted` events for the same prompt as
its candidate list grows. GattLab keeps listening until the prompt is selected,
cancelled or disposed, and exposes the newest frozen candidate snapshot. To
wait for a particular candidate, wait on that snapshot instead of sleeping.
Selection is exact: the normalized address must match one current candidate,
and no match fails with `PromptDeviceNotFoundError` before any protocol command
is sent.

## Discovery response completion

The `discoveryResponse: true` capability means GattLab can observe a discovery
request and answer it. It does not mean every answer settles the application's
promise.

A successful discovery response settles normally. An unsuccessful one has been
observed to leave discovery incomplete and the application's promise pending.
GattLab therefore does not wait for it indefinitely: the response call rejects
at the pending-operation deadline with `BluetoothTimeoutError` and
`knownLimitation: 'unsuccessful-discovery-does-not-settle'`. Do not rely on a
failing discovery branch in your application being reachable through
GattLab.

GattLab errors keep internal failures as their `cause`. Their diagnostic
context holds only copied, frozen JSON-like values; byte payloads are
summarized or copied into number arrays first.

## Characteristic writes and subscriptions

Chromium reports the deprecated `writeValue()` separately from the explicit
methods. GattLab keeps the three intents apart as `default-deprecated`,
`with-response` and `without-response`, and does not treat the deprecated
path as equivalent to either explicit method.

On the pinned browser, `writeValueWithoutResponse()` resolves even when the
test scripts `write-not-permitted`. GattLab still records the exact bytes and
the `without-response` intent and consumes the queued error, but the
application never receives that error. A resolved promise is therefore not
proof that a peripheral accepted the value. The application's promise can also
resolve before `waitForWrite()` does and before the write journal updates, so
assert the application outcome and the journal separately.

Subscription and unsubscription responses can be scripted, but they are only
request and response handshakes. Chromium's emulation protocol has no command
that sends a notification value, so GattLab cannot produce
`characteristicvaluechanged`.

Chromium emits subscription requests only when a notifying or indicating
characteristic has the Client Characteristic Configuration descriptor
(`0x2902`). Without it, `startNotifications()` fails natively with
`NotSupportedError` and no protocol event is emitted. Core validation
therefore rejects a `notify` or `indicate` characteristic without `0x2902`
with `missing-cccd-descriptor`.

## Advertisement scan defaults

`BluetoothEmulation.simulateAdvertisement` has been observed to stay pending
when the protocol-optional `appearance` or `txPower` field is missing. GattLab
therefore always sends both and supplies `0` for an omitted value. Explicit
values, including an explicit zero, are sent unchanged.

The substituted values can reach the application in an advertisement event.
Appearance `0` means unknown, but a transmit power of `0` is a real 0 dBm, so an
omitted transmit power looks the same as an explicit zero. The advertisement
timeline entry records `appearanceSubstituted`, `txPowerSubstituted` and that
the transmit-power substitution is visible to the application.

## Secondary GATT services

The protocol's `BluetoothEmulation.addService` command cannot mark a service as
primary or secondary. The core model keeps the distinction, but the CDP backend
reports `secondaryServices: false` and rejects a secondary service before
sending anything. It never silently turns a secondary service into a primary
one.

## Scripted disconnection and reconnection

After `simulateGATTDisconnection`, Chromium has been observed to drop the
peripheral from later chooser snapshots and to invalidate its service,
characteristic and descriptor ids. Registering it again or advertising does
not restore discovery on its own. GattLab therefore rebuilds the GATT hierarchy from the peripheral
definition before `peripheral.disconnect()` resolves. Public handles and their
queued responses stay the same while Chromium's internal ids change.

A new `requestDevice()` chooser models a fresh scan. Arm and open the chooser
first, then call `peripheral.advertise()`, then select the same handle. The
peripheral definition must include `advertisement`. An advertisement is not a
persistent registration, so advertising before the chooser opens does not
work. The Vanilla and React sample tests run this reconnection on the pinned
browser.

## Simulation fidelity

GattLab exercises the Web Bluetooth behavior of Chromium's virtual adapter. It
does not simulate radio conditions, RF timing or interference, controller
scheduling, L2CAP, SMP, pairing or bonding, ATT MTU negotiation or packet
fragmentation. A passing GattLab test says something about your application's
browser-facing behavior, not about radio, timing, security procedures or the
complete Bluetooth stack.

Application-visible behavior follows the Web Bluetooth specification; browser
behavior follows the pinned Chromium version. Response codes follow the
Bluetooth Core Specification v6.3, and UUID Assigned Numbers use the
2026-08-05 list. Numeric UUID forms are supported, without free-form service
aliases. ATT and HCI scripting names stay stable when specification wording
changes. GattLab implies no affiliation with or endorsement by Bluetooth SIG.

## Document destruction and process reuse

Chromium's Bluetooth emulation is shared by the whole browser process. It can
be lost when a document that used Web Bluetooth is destroyed by navigation,
reload or page closure, including a document in another page or browser
context of the same process. Checking availability, cancelling a chooser,
selecting a device without connecting and reading over a connection all count
as use. Closing an unused page or changing only the URL hash or history does
not cause the loss. Navigation alone never ends a GattLab lab; GattLab reacts
only to loss it actually detects.

Loss is not immediate. `page.close()` resolving does not mean the loss is
already visible, and the next operation can still succeed before a later one
fails. GattLab does not poll continuously and never retries a failed
operation.

GattLab recognizes Chromium's rejection for a missing emulation binding. Before
chooser work and asynchronous handle work it also runs a short liveness check
that reapplies the current adapter state without changing it. The lab then
ends with `BluetoothBackendStoppedError`:

- `reason: 'adapter-lost'` when the adapter is gone, keeping the original
  transport or protocol error as the cause;
- `reason: 'fixture-page-closed'` when the fixture's own page was closed;
- `reason: 'model-outcome-unknown'` when registration, preconnection or
  disconnection stopped after it had already changed the model, keeping the
  original timeout or cancellation as the cause.

All three carry `remediation: 'new-test-fixture'`; see the
[terminal lab contract](api.md#terminal-lab-context). GattLab never repairs or
replays the model.

A registration that races document destruction may get no reply from
Chromium. Its error then arrives only at the **30-second command deadline**,
with `model-outcome-unknown`, `model-operation-aborted` and the original
`BluetoothTimeoutError`. The model is invalidated without claiming that the
adapter was lost. Direct users of the CDP factory can shorten this deadline
with `commandDeadlineMs`; the Playwright fixture always uses 30,000 ms,
independent of its assertion and prompt timeouts.

After the lab ends, old handles keep their identity and journal snapshots.
Active operations, queue calls and already obtained prompts reject with the
first recorded terminal error, and pending GattLab waits settle exactly once.
Cleanup stays idempotent; a closed fixture page can add a reportable
page-session cleanup failure. A new test fixture can then reuse the cleaned
browser process with an empty model. The old fixture cannot restart, adopt
another page or take over the new fixture's lease.

`navigator.bluetooth.getAvailability() === true` does **not** mean the virtual
adapter is still live: a new document can report `true` after the emulation was
lost. Chromium's source suggests that such a document could fall back to a
real host adapter, although this has not been demonstrated. Ending the lab
stops GattLab's own chooser handling and responses, but it does not intercept
the application's own Web Bluetooth calls or isolate the host adapter.

Started protocol commands have their own 30,000 ms deadline, separate from
`operationTimeoutMs` and `promptTimeoutMs`. Registration, preconnection and
the hierarchy rebuild share one deadline. After a deadline that did not touch
the model, GattLab runs at most one bounded health check; if the model may
have changed, the lab ends immediately. When an earlier state or liveness
command is still unanswered, a later check sends nothing and reports an
unconfirmed timeout with `centralStateBlocked: true` and remediation
`dispose-lab`; it does not assume the adapter was lost. The 30-second default
is far above how long these commands normally take; it only bounds a command
that Chromium never answers.

See the [deadline and error fields](api.md#independent-command-and-application-deadlines)
and [troubleshooting](troubleshooting.md#document-destruction-and-process-reuse).
A scripted GATT disconnection on a live adapter, followed by the hierarchy
rebuild, remains a separate supported journey.
