# React Web Bluetooth sample

This browser application uses React **19.3.1** and the real Web Bluetooth API.
React renders its state; a plain TypeScript session owns native Bluetooth
objects and a single disconnect listener. The application imports the canonical
[Vanilla profile](../vanilla-ts/src/bluetooth-profile.ts). GattLab is used only
by its tests, through installed package tarballs.

## Build and run

Use the repository's Node **26.11.1**, pnpm **12.11.2**, TypeScript **6.0.3**,
Vite **8.3.8** and Playwright **1.65.1**. React/React DOM are pinned to 19.3.1,
their type packages to 19.3.0, and the Vite React plugin to 6.3.0. Vite 8.3.8
includes the fix for a high-severity advisory
([GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm)). No React Compiler, Babel installation or CDN is needed.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm browser:install
pnpm react:build
node examples/react/server.mjs --build=production
```

Open the announced `http://127.0.0.1:<port>` URL. `PORT=0` is the default;
the server serves one built directory with local JavaScript/CSS assets.
Missing files, source paths and traversal requests never fall back to HTML.
Use `--build=development` for the development runtime. Other build names are
errors.

**Connect, read, and write** selects a peripheral implementing the custom
profile, reads one byte as a percentage and writes `16,32,48` with response.
**Open chooser for cancellation** only opens the native chooser. Cancelling
either action reports `chooser-error` with the original `NotFoundError`;
failures after selection report `operation-error` and retain their original
error name. Empty result and error fields display `--`.

## First test through the public fixture

Install `@gattlab/playwright@alpha` and `@playwright/test` as described in the
[quick start](../../docs/quick-start.md), then run the built sample's server
and set `REACT_SAMPLE_URL` to its announced URL.
The following test needs only the public package and Playwright declarations:

```ts
import { bytes, expect, test } from '@gattlab/playwright';

test.use({
  headless: true,
  launchOptions: {
    args:
      process.platform === 'linux' ? ['--enable-features=WebBluetooth'] : [],
  },
});

test('reads and writes through React', async ({ page, bluetooth }) => {
  const url = process.env.REACT_SAMPLE_URL;
  if (url === undefined) throw new Error('Set REACT_SAMPLE_URL first.');
  await page.goto(url);
  await expect(page.getByTestId('status')).toHaveText('app-ready');
  const serviceUuid = '12345678-1234-5678-9abc-def123457000';
  const ioUuid = '12345678-1234-5678-9abc-def123457001';
  const peripheral = await bluetooth.createPreconnectedPeripheral({
    address: '47:41:54:54:51:01',
    name: 'React sample sensor',
    services: [
      {
        uuid: serviceUuid,
        characteristics: [
          {
            uuid: ioUuid,
            properties: ['read', 'write', 'write-without-response'],
            initialValue: [87],
          },
        ],
      },
    ],
  });
  const io = peripheral.characteristic(serviceUuid, ioUuid);
  io.reads.queue(bytes([73]));
  const read = io.expectRead();
  const write = io.waitForWrite();
  const prompt = bluetooth.waitForDevicePrompt();
  await page.locator('#connect').click();
  await (await prompt).select(peripheral);
  await Promise.all([read, write]);
  await expect(page.getByTestId('status')).toHaveText('ready');
  await expect(page.getByTestId('battery')).toHaveText('73%');
  await expect(page.getByTestId('written')).toHaveText('16,32,48');
});
```

Linux requires the Web Bluetooth feature flag above. Use Playwright's bundled
Chromium headless shell, not another browser executable, to reproduce the
validated baseline. The fixture starts lazily after navigation and owns lab
teardown; tests do not call `start()` or construct another lab.

## Session and StrictMode

The click handler calls the session synchronously. The session calls
`navigator.bluetooth.requestDevice()` before its first `await`, preserving
the native user activation. Browser objects stay outside React state, props
and refs. `useSyncExternalStore` reads an immutable snapshot whose reference
stays stable until its data changes. Effect cleanup only unsubscribes.

At every selection, the session removes its previous native listener before
registering one listener on the selected device, including when Chromium
returns the same device instance. Each native disconnect increments
`disconnect-events` once. `dispose()` removes the listener before disconnecting
and is idempotent; page exit disposes the session outside React's effects.

The root uses `<StrictMode>` in both builds. React replays mount effects only
with its development runtime, so the builder runs production and development
in separate child processes with explicit `NODE_ENV` before importing Vite.
`mode: 'development'` alone is insufficient. Test R4 uses the development
build; the probe verifies a React development-runtime marker in the emitted bundle
and its absence from production. It also builds the incorrect `mode`-only
variant and requires the runtime guard to reject it.

## Tests

```sh
pnpm react:test
pnpm react:probe
```

`pnpm react:test` runs fast source checks. `pnpm react:probe` installs the
packed packages into a temporary project, checks every test, config and
support file with TypeScript 6.0.3 and 5.9.3, and runs four tests once in
Chromium:

- **R1** reconnects to the same peripheral and renders two readings, 73 and 42;
- **R2** cancels the chooser from both actions without any GATT traffic;
- **R3** shows a scripted ATT read error and never writes or renders success;
- **R4** checks that development-mode StrictMode keeps a single native
  disconnect listener.

A fifth test expects `74%` on purpose and fails; the probe checks that this
assertion stays the reported failure and that redacted GattLab attachments are
produced. Every server the tests start must exit. The
[test file](../../tools/react-app-fixtures/tests/react-app.spec.ts) shows the
exact journal assertions and the re-advertisement sequence for reconnecting.

Notification payloads cannot be injected. Navigation and page-close behavior is
covered by `pnpm navigation:probe`, not by this sample. See
[compatibility](../../docs/compatibility.md) and
[protocol limitations](../../docs/protocol-limitations.md).
