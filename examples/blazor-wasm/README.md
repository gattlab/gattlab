# Blazor WebAssembly sample

This standalone sample uses the real browser Web Bluetooth API through a C#
`BluetoothService`. Razor owns every visible state; JavaScript owns native
Bluetooth objects and returns typed results or the original DOMException
name/message/category. Native `gattserverdisconnected` calls an owned .NET
object reference, and C# schedules the render. There is no GattLab dependency
in the application, no Blazor Server/Auto transport, and no test-only browser
API replacement.

The [general consumer quick start](../../docs/quick-start.md),
[API semantics](../../docs/api.md), [troubleshooting](../../docs/troubleshooting.md)
and [compatibility](../../docs/compatibility.md) explain installed GattLab use.
Notification payloads cannot be injected. Each Chromium process permits one
active lab; see
the [document-destruction limitation](../../docs/protocol-limitations.md#document-destruction-and-process-reuse).

## Run locally

Use the repository's Node 26.11.1/pnpm 12.11.2 and install .NET SDK **10.0.401**.
The sample-local `global.json` disables roll-forward; the target/framework is
`net10.0`/**10.0.10**, with NuGet dependencies committed in `packages.lock.json`.
Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm browser:install
pnpm blazor:build
node examples/blazor-wasm/server.mjs
```

Open the announced `http://127.0.0.1:<port>` in a Web Bluetooth-capable Chromium.
The server uses an ephemeral port by default (`PORT=0`) and serves only
`dist/wwwroot`; source files and missing framework paths are not HTML fallback
routes. It serves plain bytes even when the SDK also publishes `.br`/`.gz`
variants. WASM uses `application/wasm`; all boot assets are local, with no CDN.
No extra workload is required for this non-AOT sample. The SDK's optional
`wasm-tools` recommendation during publish is not a prerequisite.

The buttons remain disabled until the panel's Bluetooth session exists after
first render. Click **Connect, read, and write** to choose a matching device,
read one IO byte as the battery percentage, and write `16,32,48` with response.
**Open chooser for cancellation** exercises only the native chooser. With
physical hardware, the peripheral must implement the custom profile exported by
`wwwroot/bluetooth-profile.js` (not the standard Battery Service).

## Actions and component lifecycle

`BluetoothPanel.razor` owns one JavaScript session (`createSession` in
`wwwroot/bluetooth.js`); `App.razor` hosts it and renders the lifecycle log.
The session keeps its device, listeners, receiver, id and disposed flag in its
own closure. A disposed session removes its native listener before it
disconnects and settles pending work as a `disposed` result.

- **Check adapter availability** — `getAvailability()` as a C# value
  (`available`/`unavailable`). Scenario E1.
- **Subscribe / Unsubscribe** — native notification handshakes only; no
  notification payload reaches C# because GattLab cannot inject one. Failures keep their
  DOMException name (`subscription-error`, `unsubscription-error`). E2, E3.
- **Partial success** — a rejected write after a successful read renders both
  the battery value and the write error (`write-error`). E4.
- **Reconnect** — after a scripted disconnect a new chooser opens and the test
  re-advertises (the hierarchy is restored internally). E5.
- **Rerender panel** stays enabled while an action is pending; the chooser
  continues and no second request starts. L1.
- **Hide / Show Bluetooth panel** disposes and recreates the panel and its
  session. L2a/L2b dispose it while the chooser is open (then cancel or select
  the old prompt after the new session exists); L3 disposes it while connected
  and then disconnects the device that session 2 reconnected.

The lifecycle log (`data-testid="lifecycle-log"`) is ordinary Razor output.
Each entry carries the session id that C# allocated and JavaScript echoes back:
`created`, `disposed`, `request`, `result`, `settled <id> disposed`, `callback`
and `native-event`. Defects are `late-result`, `late-callback`,
`late-native-event` (a disposed session's native listener fired; the
diagnostics helper reports before the disposed guard) and `session-mismatch`.

## Test the published application

```sh
pnpm blazor:validate
```

This builds the packages and a locked Release publish of the app, installs the
packed packages into a temporary project outside the workspace, and copies only
the published browser assets, the Node server and the tests. TypeScript 6.0.3
and 5.9.3 check the tests with `strict` and `skipLibCheck: false`. The
published JavaScript assets must match the sources byte for byte, and the
profile constants must match the Vanilla sample's.

The tests, in
[`blazor-app.spec.ts`](../../tools/blazor-app-fixtures/tests/blazor-app.spec.ts)
and
[`blazor-scenarios.spec.ts`](../../tools/blazor-app-fixtures/tests/blazor-scenarios.spec.ts),
use only the public `@gattlab/playwright` API:

- **B1** — a Razor click goes through the C# service to the JavaScript chooser,
  connection, read and write, and back to the C# UI. Two peripherals return 73%
  and 42%, each with exactly one read and one write; a GattLab disconnect then
  reaches Razor through the native event and the .NET callback.
- **B2** — cancelling the chooser from either button keeps `NotFoundError` and
  category `chooser`, with no GATT traffic.
- **B3** — a scripted ATT read error keeps `NotSupportedError`, shows an
  operation error and prevents the write.
- **E1–E5** and **L1–L3** — the scenarios listed in the previous section.

A last test fails a Razor assertion on purpose; the probe checks that this
assertion stays the reported failure and that four redacted GattLab
attachments are produced. Every server the tests start must exit.

`pnpm blazor:validate` also runs the sample's source checks and
`dotnet format --verify-no-changes --no-restore`. `pnpm validate` runs the
source checks without building .NET. CI runs both on Ubuntu 24.04 with
Playwright 1.65.1's bundled headless Chromium 159.0.8154.6, launched with
`--enable-features=WebBluetooth`.

The sample tests do not navigate away from a page after using Bluetooth. Such
navigation can end the process-wide emulation on the pinned Chromium; see the
[terminal lifecycle contract](../../docs/api.md#terminal-lab-context).

.NET is needed only to build this sample; it is not a runtime dependency of any
GattLab package.
