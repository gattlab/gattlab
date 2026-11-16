# Quick start

This guide builds a complete example in a few minutes: a small web page that
reads a battery level over Web Bluetooth, and a Playwright test that drives it
with a virtual peripheral. No Bluetooth hardware is needed.

GattLab is validated with Playwright 1.65.1 and its bundled headless Chromium
159.0.8154.6 on Node.js 26.11.1. The packages require Node.js 22 or newer. See
[compatibility](compatibility.md) for other versions and platforms.

## 1. Create the project

```sh
mkdir gattlab-first-test
cd gattlab-first-test
npm init -y
npm pkg set type=module
npm install --save-dev @gattlab/playwright@beta @playwright/test
npx playwright install chromium
```

On a fresh Linux machine or CI runner, use
`npx playwright install --with-deps chromium` to install Chromium's system
libraries as well.

## 2. Add a minimal application

Create `app/index.html`. It is an ordinary Web Bluetooth page with no GattLab
code:

```html
<!doctype html>
<html lang="en">
  <meta charset="utf-8" />
  <title>Battery demo</title>
  <button>Connect</button>
  <p>Battery: <output data-testid="battery">--</output></p>
  <script type="module">
    const output = document.querySelector('output');
    document.querySelector('button').addEventListener('click', async () => {
      try {
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: ['battery_service'] }],
        });
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService('battery_service');
        const level = await service.getCharacteristic('battery_level');
        const value = await level.readValue();
        output.textContent = `${value.getUint8(0)}%`;
      } catch (error) {
        output.textContent = error.name;
      }
    });
  </script>
</html>
```

Create `app/server.mjs` to serve it on localhost, which counts as a secure
context for Web Bluetooth:

```js
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const page = await readFile(new URL('./index.html', import.meta.url));

createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(page);
}).listen(4173, '127.0.0.1');
```

In your own project, point Playwright at your existing development server
instead.

## 3. Configure Playwright

Create `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: {
      // Linux needs this flag to expose navigator.bluetooth.
      args:
        process.platform === 'linux' ? ['--enable-features=WebBluetooth'] : [],
    },
  },
  webServer: {
    command: 'node app/server.mjs',
    url: 'http://127.0.0.1:4173',
  },
});
```

## 4. Write the test

Create `tests/battery.spec.ts`:

```ts
import { bytes, expect, test } from '@gattlab/playwright';

test('shows the battery level', async ({ page, bluetooth }) => {
  await page.goto('/');

  // A virtual peripheral with a Battery Service (0x180F).
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
  battery.reads.queue(bytes([87])); // the next read returns 87

  // Arm the chooser listener, then let the app open it with a real click.
  const prompt = bluetooth.waitForDevicePrompt();
  await page.getByRole('button', { name: 'Connect' }).click();
  await (await prompt).select(sensor);

  await expect(page.getByTestId('battery')).toHaveText('87%');
  await battery.expectRead();
});
```

## 5. Run it

```sh
npx playwright test
```

Expected output is **1 passed**. Here is what happened:

1. `page.goto('/')` opened the application on a secure origin. The
   `bluetooth` fixture starts lazily on its first call and never navigates for
   you.
2. `createPeripheral()` registered a virtual peripheral and its GATT hierarchy
   in Chromium's virtual adapter.
3. `reads.queue()` scripted the answer to the next read. Without a queued
   value, reads return the characteristic's `initialValue`, or empty bytes.
4. `waitForDevicePrompt()` started listening for the chooser **before** the
   click. Web Bluetooth only opens the chooser after a user gesture, so the
   test clicks the real button.
5. `select(sensor)` picked the peripheral in the native chooser by its
   address. Chooser display names are empty in Chromium's emulation, so names
   are never used for selection.
6. The application connected, read `87` and rendered `87%`;
   `expectRead()` confirmed that the read happened.

When the test ends, the fixture disables the emulation, which removes the
virtual peripheral, and frees the browser process for the next test.

## When a test fails

On an unexpected failure GattLab attaches `gattlab-diagnostics.json`,
`gattlab-summary.md`, `gattlab-capabilities.json` and `gattlab-devices.json`
to the test result, where Playwright reporters such as `list` and `html` show
them. Payload bytes are redacted to their lengths by default, and your own
assertion remains the primary failure. See [troubleshooting](troubleshooting.md)
for common causes.

If the run uses a browser or Playwright version other than the validated one,
the report also carries a `gattlab-compatibility` annotation marking the run
`unverified`.

## Things to know

- **Arm listeners before the action.** Call `waitForDevicePrompt()` and
  `waitForWrite()` before the click that triggers them.
- **One lab per browser process.** Each Playwright worker launches its own
  browser, so parallel workers are fine; contexts within one browser share a
  single virtual adapter.
- **Stay on one document per Bluetooth journey.** Reloading, navigating or
  closing a page that used Web Bluetooth can make Chromium drop the virtual
  adapter. GattLab then fails further calls with a typed error; continue in a
  new test. See the
  [document-destruction limitation](protocol-limitations.md#document-destruction-and-process-reuse).
- **No notification payloads.** Subscription handshakes work, but Chromium
  offers no way to push a notification value. See
  [notification limitations](protocol-limitations.md#characteristic-writes-and-subscriptions).

## Next steps

- Writes, ATT and HCI errors, adapter states, reconnection and fixture options:
  [`@gattlab/playwright`](../packages/playwright/README.md)
- Exact error fields and lifecycle rules: [API semantics](api.md)
- Larger applications tested through the installed packages:
  [Vanilla TypeScript](../examples/vanilla-ts/README.md),
  [React](../examples/react/README.md) and
  [Blazor WebAssembly](../examples/blazor-wasm/README.md)
