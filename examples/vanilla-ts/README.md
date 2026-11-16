# Vanilla TypeScript Web Bluetooth sample

This sensor console uses HTML, CSS, and strict TypeScript with the real
`navigator.bluetooth` API. It shows device selection, connection and discovery,
read/write, cancellation, disconnection and reconnection, adapter availability,
and subscription/unsubscription. The application contains no test dependency.
Its tests drive it through the public GattLab fixture, installed from the
packed packages into a separate project.

For a complete consumer setup outside this workspace, use the
[general quick start](../../docs/quick-start.md). See
[API semantics](../../docs/api.md), [troubleshooting](../../docs/troubleshooting.md)
and [compatibility](../../docs/compatibility.md). Notification payloads cannot
be injected, and each Chromium process permits one active lab. The
[document-destruction limitation](../../docs/protocol-limitations.md#document-destruction-and-process-reuse)
is separate from the scripted reconnect journey shown below.

## Prerequisites

Use Node.js **26.11.1**, pnpm **12.11.2**, and the pinned Playwright **1.65.1**
with its bundled Chromium **159.0.8154.6**. Tests run headless, without BLE
hardware. On Linux, Chromium needs `--enable-features=WebBluetooth`; the test
config supplies this launch argument. Web Bluetooth requires HTTPS or localhost
and a user gesture to open the chooser.

The browser source uses exactly `@types/web-bluetooth` **0.0.22** (MIT) for Web
Bluetooth declarations, selected by `"types": ["web-bluetooth"]` in
`tsconfig.json`. The repository installs it automatically. If you copy the
application into an existing TypeScript project, add that one extra dependency:

```sh
pnpm add --save-dev --save-exact @types/web-bluetooth@0.0.22
```

Keep `strict`, `skipLibCheck: false`, and the explicit browser `types` list.
There is no bundler or framework. Node types belong to the test harness, not
the browser application.

## Run the application

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm browser:install
pnpm vanilla:build
node examples/vanilla-ts/server.mjs
```

Open `http://127.0.0.1:4173` in a Web Bluetooth-capable browser. A manual device
journey requires a real compatible peripheral; the automated tests supply the
virtual devices. Edit `src/app.ts` or `src/bluetooth-profile.ts` and rerun
`pnpm vanilla:build` to update the gitignored `dist/` JavaScript and declarations.

The server exposes only `/`, `/dist/app.js`, `/dist/bluetooth-profile.js`, and
`/styles.css`; TypeScript sources and declarations are not HTTP assets.

## Run the tests

From the repository root, after the installation above:

```sh
pnpm vanilla:probe
```

This builds the packages and the sample, packs the three packages and installs
them, with the pinned external dependencies only, into a temporary project
outside the workspace. It copies the four application assets listed above,
the tests and their Playwright config. TypeScript 6.0.3 and 5.9.3 then check
both the sample source and the tests against the installed declarations, with
`strict` and `skipLibCheck: false`, before Playwright starts.

The tests start `node app/server.mjs` with `PORT=0`, read the URL from the
first line of its output and wait for the process to exit in teardown. The
probe records every server it starts and fails if one is still running after a
Playwright run, even when all assertions passed; its own cleanup stops any
leftover server before removing the temporary project.

The probe runs, with one worker:

1. the eleven scenarios in `tests/vanilla-app.spec.ts` three times in a row
   (`--repeat-each=3`);
2. the six regression tests R1–R6 in `tests/vanilla-regression.spec.ts` once;
3. `tests/artifact-failure.spec.ts`, which fails an assertion on purpose. The
   probe checks that this assertion stays the reported failure and that four
   redacted GattLab attachments are produced.

The tests use `expect.poll` only where GattLab has no wait API (the chooser
candidates after advertising in R1), never for UI text or for an operation
that `expectRead`, `waitForWrite` or `waitForDevicePrompt` can await.

## First test: choose, connect, read, and write

The test lives in
[`vanilla-app.spec.ts`](../../tools/vanilla-app-fixtures/tests/vanilla-app.spec.ts).
Its helper in [`probe-support.ts`](../../tools/vanilla-app-fixtures/tests/probe-support.ts)
creates a peripheral with the application's service and two characteristics;
`test`, `expect`, and `bytes` come from `@gattlab/playwright`. Those support
helpers belong to this repository's test suite and are not package exports. The [quick start](../../docs/quick-start.md#4-write-the-test)
shows the same order against a minimal battery page.

Navigation establishes the secure origin before the first lab operation.
`createPeripheral()` lazily starts the fixture-owned lab; no `start()` call is
needed. Arm the chooser before clicking and select the peripheral handle, not
its name. The browser application performs the actual GATT work. The fixture
awaits disposal after the test, as specified by [fixture lifecycle](../../docs/api.md#fixture-and-adapter).

## Reconnect after a scripted disconnect

Scenario 8 in `vanilla-app.spec.ts` queues reads of `87` and `42`. After the first journey it awaits
`peripheral.disconnect()` and the application's `disconnected` status. For the
second journey it arms the chooser, clicks, awaits the open prompt, calls
`peripheral.advertise()`, then selects the same peripheral handle. The
peripheral definition includes `advertisement`; advertising before opening the
new chooser is insufficient on the pinned Chromium. GattLab restores the
invalidated hierarchy internally while handles and response queues survive.
See [reconnect lifecycle](../../docs/protocol-limitations.md#scripted-disconnection-and-reconnection).

## Notification boundary

Subscription tests cover the native `startNotifications()` and
`stopNotifications()` handshakes and scripted ATT failures. GattLab's native
backend cannot inject notification payloads or later native
`characteristicvaluechanged` events; see [notification limitations](../../docs/protocol-limitations.md#characteristic-writes-and-subscriptions).

## Regression scenarios

The extra buttons below are covered by the regression tests R1–R6 in
[`vanilla-regression.spec.ts`](../../tools/vanilla-app-fixtures/tests/vanilla-regression.spec.ts).

### Read both characteristics (R2)

“Read both characteristics” opens one connection and reads the IO battery
value and the UTF-8 firmware revision in the same service. R2 scripts distinct
responses on each handle and checks both UI values plus exactly one connection
and one discovery.

### Read descriptor (R3, R6)

“Read descriptor” shows every byte of the IO characteristic's custom
`12345678-1234-5678-9abc-def123457004` descriptor, including zero and high bytes.
R3 checks its successful read and generic `NotSupportedError` for a scripted
ATT failure; R6 reads it successfully after a characteristic failure on the
same connection.

### Write descriptor (R3)

“Write descriptor” sends `[65, 0, 255]` to that descriptor, not to the
characteristic. R3 checks the exact descriptor payload and that no
characteristic write was recorded.

### Write without response (R4)

“Write without response” sends `[64, 80, 96]` with
`writeValueWithoutResponse()`. R4 checks its distinct write type and payload;
on the pinned Chromium the application resolves even when the lab scripts
an ATT failure, so success in the UI does not prove peripheral acceptance.

### Send ordered burst (R5)

“Send ordered burst” awaits five `writeValueWithResponse()` calls in order,
sending `[1, 161]` through `[5, 165]`, and reports the completed count. R5
starts a single sequential `waitForWrite()` collector before clicking;
parallel waiters would all observe the same next write, not five writes.

These actions reuse their connection until it is disconnected; an ATT failure
leaves it usable for the next action. R1 covers adapter availability:
`powered-off` remains available with a cancellable chooser, `absent` is
unavailable, and switching back to `powered-on` permits connection and read.
