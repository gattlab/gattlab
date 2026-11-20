# Troubleshoot Web Bluetooth tests

Start with the [quick start](quick-start.md) and the
[validated browser version](compatibility.md). The CDP domains GattLab uses are
experimental, and notification payloads cannot be injected. Each Chromium
process has one shared adapter, regardless of how many BrowserContexts it
hosts.

| Symptom                                                             | Diagnosis                                                                          | Remedy                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup rejects on `about:blank`                                    | Initial fixture page is not a secure Web Bluetooth origin                          | Await `page.goto()` to HTTPS or localhost before adapter/peripheral/chooser operations. GattLab does not navigate for you or restart a failed startup.                                                                                                                                                                     |
| Linux page has no `navigator.bluetooth`                             | Chromium launch omitted the required feature                                       | Set `launchOptions.args: ['--enable-features=WebBluetooth']` in your Playwright configuration; install the pinned browser with `npx playwright install --with-deps chromium`. The [quick start](quick-start.md) configuration applies the flag on Linux.                                                                   |
| Capability error in another browser/channel                         | Chromium-only required domains/environment are unavailable                         | Use Playwright 1.65.1's bundled headless Chromium; inspect `error.cause` and capability context. Successful probing of a different tuple is `unverified`, not tested support.                                                                                                                                              |
| No chooser event before prompt timeout                              | Wrong page, missing user gesture, or listener armed too late                       | Await setup (`createPeripheral` or `adapter.setState`), then call `waitForDevicePrompt()` before clicking the real UI button. Only the fixture page's chooser is controlled; another page/context is outside this session.                                                                                                 |
| Candidate missing or name is empty                                  | Names are not a chooser selection key                                              | Select the current peripheral handle by normalized address. Duplicate names are valid. Inspect the latest `prompt.devices` snapshot; wait for application/protocol state with retrying assertions, not sleeps.                                                                                                             |
| Reconnect chooser has no candidate                                  | Advertisement was sent before the new scan opened                                  | Define `advertisement`, open/await the new chooser, then `await peripheral.advertise()` and select. `disconnect()` rebuilds the hierarchy but does not advertise automatically.                                                                                                                                            |
| `BLUETOOTH_LAB_ALREADY_ACTIVE`                                      | Two labs reached the same Chromium process                                         | Use separate launched Chromium processes for simultaneous state. `connectOptions` workers may share one server/process; serialize them or use distinct servers. Context separation is insufficient. Context detection names `in-process-lease` or `cdp-domain-conflict`.                                                   |
| Model/path/queue throws validation error                            | Invalid UUID/address/bytes/properties or missing definition                        | Inspect path-aware validation issues or `error.context`, normalize supported hex forms, and include the requested service/characteristic/descriptor. A standard Battery Service does not match the Vanilla sample's custom profile.                                                                                        |
| `startNotifications()` fails without a received operation           | Notify/indicate characteristic lacks descriptor `2902`                             | Define an explicit Client Characteristic Configuration descriptor. Core returns `missing-cccd-descriptor`; successful subscription still cannot produce an injected notification payload.                                                                                                                                  |
| Operation/expectation times out                                     | No matching successful operation, pending handler, wrong path or native limitation | Arm `waitForWrite()` before action; inspect journals for request, scripted response and delivery separately. `expectRead()` first checks adapter liveness, then successful lifetime counts/full application wait; it never queues a response. Keep diagnostic deadlines; do not hide ordering defects by increasing waits. |
| `resume()` rejects with `BLUETOOTH_TIMEOUT`                         | The held request expired before the response was delivered                         | `operationTimeoutMs` runs from request registration and defaults to 5,000 ms. For an intentional longer hold, increase it with `test.use({ gattlab: { operationTimeoutMs: 15_000 } })` in that test's scope.                                                                                                               |
| Empty queue seems to hang                                           | The normal fixture supplies defaults; the low-level CDP backend does not           | In fixture tests, empty reads use `initialValue`/empty bytes and other operations succeed by default. Advanced backend hosts must handle every received connection/discovery/attribute event and send a matching response before its pending-operation deadline.                                                           |
| Unsuccessful discovery never completes natively                     | Known Chromium discovery-response limitation                                       | Expect the backend diagnostic `BLUETOOTH_TIMEOUT` and `knownLimitation: 'unsuccessful-discovery-does-not-settle'`. Do not claim the application's native promise settled.                                                                                                                                                  |
| A promise-returning handle method throws immediately after disposal | Handle state is validated before allocating a waiter                               | Await disposal before releasing the context; use a new test-scoped fixture/process for new work. Queue/lookup/expectation/write-wait calls can throw `BLUETOOTH_BACKEND_STOPPED` synchronously. Journal snapshots remain readable.                                                                                         |
| Application write resolves before the journal updates               | Write-without-response completion precedes response confirmation                   | Assert application state and eventual lab operation records separately. Scripted ATT error is not necessarily delivered to the application.                                                                                                                                                                                |
| Report has a compatibility annotation                               | Capabilities exist, but the observed tuple/mode is not validated                   | Read `gattlab-capabilities.json` and reproduce on the exact bundled headless baseline. Default successful unverified runs retain only that artifact.                                                                                                                                                                       |
| Failure attachments appear to lack data                             | Default payload redaction and bounded retention                                    | Inspect `gattlab-summary.md`, timeline, capabilities and device byte lengths. Use `artifacts: 'always'` for used successful labs or an explicit bounded truncated preview if needed; no full payload logging is available. Idle labs do not manufacture artifacts.                                                         |
| Later test fails after a participating document is destroyed        | Recognized emulation loss or terminal fixture/model lifecycle                      | Inspect the typed stopped error reason/cause below and use a new test fixture after cleanup. Successful reconnect does not prove recovery from adapter loss.                                                                                                                                                               |

## Read errors at the right layer

Application `DOMException` names describe browser-visible outcomes. A scripted
ATT/HCI name is recorded in the lab journal; generic application errors cannot
recover it. Assert both independently. Controlling-test errors use stable
`GattLabError.code` and copied/frozen `context`, with the original failure in
`cause`; do not parse arbitrary browser error messages for routing.
`CdpTransportError` is an ordinary transport Error with kind/target/method,
not a GattLab domain-code error. See the [API error table](api.md#stable-errors-and-diagnostic-context).

## Deadlines and teardown

Commands in a started lab use an independent **30,000 ms** default C.
`operationTimeoutMs` remains application/handle/pending-GATT A;
`promptTimeoutMs` remains chooser arrival P. Neither short nor long assertion
options change C, and there is no new Playwright option. Advanced CDP hosts may
set a positive finite safe-integer `commandDeadlineMs`; `operationDeadlineMs`
keeps pending-GATT semantics.

A model registration/preconnection/disconnect has one C across all hierarchy
commands and publication. Timeout/cancellation after effects makes the model
uncertain and closes the lab immediately. Other command deadlines allow at most
one diagnostic C. Chooser/handle listeners arm synchronously and retain events
through entry C; the full A/P starts afterward and expiry allows one diagnostic C.
Pending native requests keep their original A and may add one diagnostic C.
An entry-check timeout is not recursively checked. See the [API phase table](api.md#independent-command-and-application-deadlines).

Inspect `timeoutPhase`, `deadlineKind`, original `deadlineMs`, independent
`checkDeadlineMs`, `detection`, `centralStateBlocked` and `remediation`.
`live` means only that the check acknowledged the adapter at that instant;
`check-failed`, `check-timed-out`, `not-checked` and `unconfirmed` do not establish
adapter loss. A timeout does not prove that a native command failed or undo its
effects, so do not retry blindly.

When `centralStateBlocked: true` and detection is `unconfirmed`, a previous
underlying state/fence send still owns serialization. No new health command was
sent. The earlier state change may already have applied; do not claim it failed
or send another state write to resolve the uncertainty. Finish/dispose the lab
through its normal cleanup path (`remediation: 'dispose-lab'`). Other unconfirmed
outcomes use `inspect-operation`; inspect the original operation and the
bounded check result, and do not treat that hint as permission to retry.

The optional structural `CdpCommandTimeout.deadlineCheck` is non-enumerable and
frozen. Its `CdpDeadlineCheckEvidence` identifies phase `deadline-check`, command
budget C, failed/timed-out/unconfirmed detection and the actual check cause.
Read it explicitly; serializing enumerable error properties will omit it.
The primary timeout's phase, A/P/C budget and cause chain remain intact.

Raw sends, standalone probes/controllers/registries, whole startup and existing
teardown are outside the new command budget. Teardown's deadline bounds final
pending-work settlement, not all sequential cleanup commands or total wall time.
Disposal completes before context/process lease release. Cleanup errors remain
reportable after lease release and do not replace an earlier application error;
a closed fixture page can yield page-session disable/detach failures.

## Document destruction and process reuse

Closing another page has an asynchronous observation boundary: `page.close()`
resolving does not mean adapter loss is already observable. A following public
operation can still complete correctly before loss appears on a later command.
Continued full registration is valid while the adapter remains live; confirmed
loss must return the typed stopped error, never a generic transport failure or
fabricated success. This does not authorize retrying failed operations or imply
continuous health monitoring. Closing the fixture-owned chooser page separately
ends that fixture's usability with `fixture-page-closed`.

A participating document can lose process-wide emulation after availability,
chooser or GATT use followed by goto, reload or close, including another page
or context while the fixture page remains live. Hash/history changes and unused
page destruction are controls, not unconditional invalidation signals.
A retained observer can preserve the adapter; navigation events alone never
justify stopping it.

The [terminal lab contract](api.md#terminal-lab-context)
uses `BluetoothBackendStoppedError`/`BLUETOOTH_BACKEND_STOPPED` with frozen
`lifecycleState: 'invalidated'`, the attempted method's `operation` and
`operationLayer: 'playwright' | 'cdp'`. Branch on structured `reason`:

- `adapter-lost`: recognized owned emulation rejection or liveness check;
  `cause` retains the first transport/protocol evidence.
- `fixture-page-closed`: the owned chooser page closed; no replacement page
  or fabricated protocol cause is provided.
- `model-outcome-unknown`: a registration/preconnection/disconnect deadline or
  cancellation left partial effects uncertain, even if the adapter is live.
  Its original timeout/cancellation is retained as cause.

After another page closes or navigates, a registration may wait up to the
**30-second command watchdog** for a reply Chromium never sends. Its terminal
`model-outcome-unknown` / `model-operation-aborted` result retains the original
typed command timeout; it does not confirm adapter loss. See
[terminal model-uncertainty contract](api.md#terminal-lab-context).
Only direct CDP factory consumers can shorten that wait using `commandDeadlineMs`.
The Playwright facade does not expose this option; assertion and prompt options
do not shorten its 30,000 ms command budget. Use a new fixture after cleanup.

All select `remediation: 'new-test-fixture'`. The first record survives cleanup
and later disposal; already satisfied counters, old handles, queued responses
and old prompts cannot authorize active work. Identity and frozen journal
snapshots remain inspectable. Explicit cancellation that won remains primary;
ordinary disposal that won first retains its earlier disposed/stopped contract.
There is no reset/restart API or transparent replay.

Availability `true` is not a health signal for emulation: a new document can
report it after the emulation was lost. Independent application calls could
then reach a real host adapter, although this has not been demonstrated. Lab invalidation blocks
GattLab-owned chooser work, not independent application Bluetooth calls.

The [consumer example](../packages/playwright/README.md#document-changes-and-command-timeouts)
branches on terminal reasons and blocked timeout diagnostics while retaining
the original error.
