import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertBlazorApplicationBoundary,
  assertBlazorInteropImports,
  assertBlazorJavaScript,
  assertBlazorSessionModule,
  assertBlazorSharedProfile,
  assertBlazorSourceBoundary,
} from './check-blazor-sample.mjs';
import {
  assertBlazorAssetParity,
  assertPublishedOnlyBlazorApplication,
} from './blazor-probe-checks.mjs';

const root = resolve('examples/blazor-wasm');
const interop = await readFile(resolve(root, 'wwwroot/bluetooth.js'), 'utf8');

test('handwritten Blazor app obeys boundaries and uses the live shared profile', async () => {
  await assertBlazorApplicationBoundary(root);
});

test('every required DOM family and computed property is rejected, not Bluetooth listeners', () => {
  for (const source of [
    'document;',
    'window.document;',
    "globalThis['document'];",
    'node.querySelector("#battery");',
    'node.querySelectorAll("button");',
    'node.getElementById("status");',
    'node.textContent = "ready";',
    "node['textContent'] = 'ready';",
    'node.innerHTML = "";',
    'node.innerText = "";',
    'node.outerHTML = "";',
    'node.insertAdjacentHTML("beforeend", "");',
    'node.insertAdjacentText("beforeend", "");',
    'node.insertAdjacentElement("beforeend", value);',
    'node.append(value);',
    'node.appendChild(value);',
    'node.replaceChildren();',
    'node.setAttribute("disabled", "");',
    'node.nodeValue = "";',
    'node.replaceWith(value);',
    'node.before(value);',
    'node.after(value);',
    'node.prepend(value);',
  ])
    assert.throws(
      () => assertBlazorJavaScript(source, 'mutated-helper.js'),
      /Razor DOM ownership/u,
      source,
    );
  assertBlazorJavaScript(
    "device.addEventListener('gattserverdisconnected', callback); device.removeEventListener('gattserverdisconnected', callback);",
    'bluetooth.js',
  );
  assert.throws(
    () => assertBlazorSourceBoundary('ElementReference node;', 'App.razor'),
    /ElementReference/u,
  );
});

test('missing, dead, shadowed profile imports and copied JS data are rejected', () => {
  for (const source of [
    interop.replace(
      "from './bluetooth-profile.js'",
      "from './shadow-profile.js'",
    ),
    interop.replaceAll('services: [serviceUuid]', 'services: [other]'),
    interop.replace(
      'getPrimaryService(serviceUuid)',
      'getPrimaryService(other)',
    ),
    interop.replace(
      'getCharacteristic(ioCharacteristicUuid)',
      'getCharacteristic(other)',
    ),
    interop.replace('new Uint8Array(writePayload)', 'new Uint8Array(other)'),
    interop.replace(
      'getCharacteristic(\n        notificationCharacteristicUuid,\n      )',
      'getCharacteristic(other)',
    ),
    interop.replace(
      '  notificationCharacteristicUuid,\n  serviceUuid,',
      '  serviceUuid,',
    ),
    interop.replace(
      'await characteristic.startNotifications();',
      'await characteristic.readValue();',
    ),
    `${interop}\nfunction shadow(serviceUuid) { return serviceUuid; }`,
    'import { serviceUuid, ioCharacteristicUuid, writePayload } from "./bluetooth-profile.js";',
  ])
    assert.throws(
      () => assertBlazorSharedProfile(source, 'bluetooth.js'),
      /profile|shared|shadow/u,
    );
  for (const source of [
    "const uuid = '12345678-1234-5678-9abc-def123457000';",
    'const data = new Uint8Array([16, 32, 48]);',
    'const data = Uint8Array.of(16, 32, 48);',
  ])
    assert.throws(() => assertBlazorJavaScript(source, 'copied.js'), /copied/u);
  assertBlazorJavaScript(
    'const result = []; const battery = value.getUint8(0);',
    'native-result.js',
  );
  assert.throws(
    () =>
      assertBlazorJavaScript(
        'export const data = (() => 16)();',
        'bluetooth-profile.js',
        { profile: true },
      ),
    /only exported constant data/u,
  );
});

test('the session module keeps state per session and listens only through the diagnostics helper', () => {
  assertBlazorSessionModule(interop, 'bluetooth.js');
  for (const [source, diagnostic] of [
    [`let receiver;\n${interop}`, /no module-level state/u],
    [`const sessions = new Map();\n${interop}`, /no module-level state/u],
    [
      interop.replace(
        "    listen(device, 'gattserverdisconnected', onDisconnected);",
        "    device.addEventListener('gattserverdisconnected', onDisconnected);",
      ),
      /raw addEventListener outside the diagnostics helper/u,
    ],
    [
      `${interop}\nfunction extra(target) { target.addEventListener('x', () => undefined); }`,
      /raw addEventListener outside the diagnostics helper/u,
    ],
    [
      interop.replace(
        ".invokeMethodAsync('OnNativeEvent', sessionId, type)",
        '.toString()',
      ),
      /report native events/u,
    ],
    // The report must precede the disposed guard and be unconditional.
    [
      interop.replace(
        '      diagnosticsReceiver\n        .invokeMethodAsync',
        '      if (!disposed) diagnosticsReceiver\n        .invokeMethodAsync',
      ),
      /before any disposed guard/u,
    ],
    [
      interop.replace(
        '    const observed = (event) => {\n',
        '    const observed = (event) => {\n      if (disposed) return;\n',
      ),
      /before any disposed guard/u,
    ],
    [
      interop.replace(
        '    const observed = (event) => {\n',
        '    const observed = (event) => {\n      if (!disposed) handler(event);\n',
      ),
      /before any disposed guard/u,
    ],
    [
      interop.replace(
        '      diagnosticsReceiver\n        .invokeMethodAsync',
        '      disposed ||\n        diagnosticsReceiver.invokeMethodAsync',
      ),
      /before any disposed guard/u,
    ],
    [
      interop.replace(
        '      diagnosticsReceiver\n        .invokeMethodAsync',
        '      diagnosticsReceiver\n        ?.invokeMethodAsync',
      ),
      /before any disposed guard/u,
    ],
    // Nothing may run before the report, and nothing may replace it.
    [
      interop.replace(
        '    const observed = (event) => {',
        '    const observed = (event, early = handler(event)) => {',
      ),
      /before any disposed guard/u,
    ],
    [
      interop.replace(
        "invokeMethodAsync('OnNativeEvent', sessionId, type)",
        "invokeMethodAsync('OnNativeEvent', handler(event), type)",
      ),
      /before any disposed guard/u,
    ],
    [
      interop.replace(
        '    const observed = (event) => {',
        '    const observed = (...event) => {',
      ),
      /before any disposed guard/u,
    ],
    [
      interop.replace(
        '  function listen(target, type, handler) {',
        '  function listen(target, type, handler, diagnosticsReceiver = { invokeMethodAsync: async () => undefined }) {',
      ),
      /before any disposed guard/u,
    ],
    [
      interop.replace(
        '  function release() {',
        '  function release() {\n    diagnosticsReceiver.invokeMethodAsync = async () => undefined;',
      ),
      /cannot be reassigned/u,
    ],
    [
      interop.replace(
        '  function release() {',
        '  function release() {\n    Object.assign(diagnosticsReceiver, { invokeMethodAsync: async () => undefined });',
      ),
      /used only by the listen\(\) report/u,
    ],
    [
      interop.replace(
        '  function release() {',
        '  function release() {\n    diagnosticsReceiver = { invokeMethodAsync: async () => undefined };',
      ),
      /cannot be reassigned/u,
    ],
    [
      interop.replace(
        '  let disposed = false;',
        '  let disposed = false;\n  const sessionId = 0;',
      ),
      /cannot be shadowed/u,
    ],
    [
      interop.replace(
        'createSession(sessionId, panelReceiver, diagnosticsReceiver)',
        'createSession(sessionId, panelReceiver, diagnosticsReceiver = fake)',
      ),
      /plain parameters/u,
    ],
    // `arguments[2]` aliases the receiver without naming it.
    [
      interop.replace(
        '  const listeners = [];\n',
        '  const listeners = [];\n  const sink = arguments[2];\n',
      ),
      /arguments cannot alias createSession parameters/u,
    ],
    [
      interop.replace(
        '    target.addEventListener(type, observed);',
        '    target.addEventListener(type, (event) => {\n      if (!disposed) observed(event);\n    });',
      ),
      /before any disposed guard/u,
    ],
  ]) {
    assert.notEqual(source, interop, 'mutation must change the module');
    assert.throws(
      () => assertBlazorSessionModule(source, 'bluetooth.js'),
      diagnostic,
    );
  }
});

test('only the service imports the module and creates sessions', () => {
  const service =
    'await runtime.InvokeAsync<IJSObjectReference>("import", "./bluetooth.js"); await module.InvokeAsync<IJSObjectReference>(\n "createSession", id);';
  assertBlazorInteropImports(service, 'BluetoothService.cs', { service: true });
  for (const source of [
    service.replace('"createSession"', '"import"'),
    `${service} await module.InvokeAsync<IJSObjectReference>("createSession", id);`,
    `${service} await module.InvokeAsync<IJSObjectReference>(name);`,
  ])
    assert.throws(
      () =>
        assertBlazorInteropImports(source, 'BluetoothService.cs', {
          service: true,
        }),
      /shadow interop/u,
    );
  assert.throws(
    () =>
      assertBlazorInteropImports(
        'await js.InvokeAsync<IJSObjectReference>("createSession", 1);',
        'BluetoothPanel.razor',
        { service: false },
      ),
    /shadow interop/u,
  );
});

test('boundary catches C#/JS package references but permits the sample namespace', () => {
  for (const source of [
    'using GattLab.Core;',
    'using GattLab.Playwright;',
    "import x from '@gattlab/core';",
    "import x from 'playwright';",
    "import x from '../../tools/helper.js';",
  ]) {
    assert.throws(
      () => assertBlazorSourceBoundary(source, 'application.cs'),
      /cannot reference/u,
    );
  }
  assertBlazorSourceBoundary(
    'namespace GattLab.BlazorSample.Services;',
    'service.cs',
  );
});

test('helpers, inline scripts, C# byte collections and interop shadow paths cannot bypass guards', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'gattlab-blazor-boundary-'));
  try {
    for (const [file, source, diagnostic] of [
      [
        'wwwroot/hidden/helper.js',
        "node['textContent'] = '73%';",
        /DOM ownership/u,
      ],
      ['wwwroot/dist/helper.js', 'node.textContent = "73%";', /DOM ownership/u],
      [
        'wwwroot/index.html',
        '<button onclick="this.textContent = 73">fake</button>',
        /inline DOM handlers/u,
      ],
      [
        'wwwroot/index.html',
        '<script>window.document.querySelector("#status").textContent = "ready";</script>',
        /DOM ownership/u,
      ],
      [
        'Services/Copied.cs',
        'byte[] value = new byte[] { 16, 32, 48 };',
        /numeric byte collection/u,
      ],
      [
        'Services/Copied.cs',
        'byte[] value = [16];',
        /numeric byte collection/u,
      ],
      [
        'Services/Copied.cs',
        'var uuid = "12345678-1234-5678-9abc-def123457000";',
        /copied UUID/u,
      ],
      [
        'Services/BluetoothService.cs',
        'InvokeAsync<IJSObjectReference>("import", "./shadow.js");',
        /checked local interop/u,
      ],
    ]) {
      await cp(root, fixture, {
        recursive: true,
        filter: (path) => !/\/(?:bin|obj|dist)(?:\/|$)/u.test(path),
      });
      const target = resolve(fixture, file);
      await mkdir(resolve(target, '..'), { recursive: true });
      const original =
        file === 'wwwroot/index.html' ? await readFile(target, 'utf8') : '';
      await writeFile(target, original + source);
      await assert.rejects(
        assertBlazorApplicationBoundary(fixture),
        diagnostic,
      );
      await rm(target, { force: true });
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('published/copied module parity and actual Vanilla export parity reject drift', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'gattlab-blazor-parity-'));
  try {
    await cp(resolve(root, 'wwwroot'), fixture, { recursive: true });
    await assertBlazorAssetParity(process.cwd(), fixture);
    await writeFile(
      resolve(fixture, 'bluetooth-profile.js'),
      'export const writePayload = [99];',
    );
    await assert.rejects(
      assertBlazorAssetParity(process.cwd(), fixture),
      /byte-identical/u,
    );
    await cp(resolve(root, 'wwwroot'), fixture, { recursive: true });
    await writeFile(
      resolve(fixture, 'bluetooth.js'),
      `${interop}\n// changed publish output\n`,
    );
    await assert.rejects(
      assertBlazorAssetParity(process.cwd(), fixture),
      /byte-identical/u,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('matching test fixture drift cannot hide copied UUID/payload or a JS-owned UI', async () => {
  const fixture = await mkdtemp(
    join(tmpdir(), 'gattlab-blazor-matched-drift-'),
  );
  const app = resolve(fixture, 'app');
  try {
    await cp(root, app, {
      recursive: true,
      filter: (path) => !/\/(?:bin|obj|dist)(?:\/|$)/u.test(path),
    });
    await mkdir(resolve(fixture, 'consumer/tests'), { recursive: true });
    await writeFile(
      resolve(fixture, 'consumer/tests/probe-support.ts'),
      "export const ioUuid = '12345678-1234-5678-9abc-def123457099'; export const writePayload = [99];",
    );
    await writeFile(
      resolve(app, 'wwwroot/bluetooth.js'),
      interop.replace(
        'getCharacteristic(ioCharacteristicUuid)',
        "getCharacteristic('12345678-1234-5678-9abc-def123457099')",
      ),
    );
    await assert.rejects(assertBlazorApplicationBoundary(app), /copied UUID/u);
    await writeFile(
      resolve(app, 'wwwroot/bluetooth.js'),
      interop.replace('new Uint8Array(writePayload)', 'new Uint8Array([99])'),
    );
    await assert.rejects(
      assertBlazorApplicationBoundary(app),
      /copied numeric byte collection/u,
    );
    await writeFile(resolve(app, 'wwwroot/bluetooth.js'), interop);
    await writeFile(
      resolve(app, 'Services/Copied.cs'),
      'byte[] written = [99];',
    );
    await assert.rejects(
      assertBlazorApplicationBoundary(app),
      /numeric byte collection/u,
    );
    await rm(resolve(app, 'Services/Copied.cs'));
    const razor = await readFile(resolve(app, 'BluetoothPanel.razor'), 'utf8');
    assert.ok(razor.includes('result = settled;'));
    await writeFile(
      resolve(app, 'BluetoothPanel.razor'),
      razor.replace('result = settled;', 'result = new();'),
    );
    await writeFile(
      resolve(app, 'wwwroot/bluetooth.js'),
      `${interop}\nfunction fakeUi(node) { node['textContent'] = '73%'; }`,
    );
    await assert.rejects(
      assertBlazorApplicationBoundary(app),
      /DOM ownership/u,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('changing both source and publish profile still fails against the real Vanilla source', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'gattlab-blazor-export-drift-'));
  try {
    const source = resolve(fixture, 'examples/blazor-wasm/wwwroot');
    const vanilla = resolve(fixture, 'examples/vanilla-ts/src');
    const published = resolve(fixture, 'consumer/wwwroot');
    await mkdir(vanilla, { recursive: true });
    await cp(
      'examples/vanilla-ts/src/bluetooth-profile.ts',
      resolve(vanilla, 'bluetooth-profile.ts'),
    );
    await cp(resolve(root, 'wwwroot'), source, { recursive: true });
    const changed = (
      await readFile(resolve(source, 'bluetooth-profile.js'), 'utf8')
    ).replace('Object.freeze([16, 32, 48])', 'Object.freeze([99, 32, 48])');
    await writeFile(resolve(source, 'bluetooth-profile.js'), changed);
    await cp(source, published, { recursive: true });
    await assert.rejects(
      assertBlazorAssetParity(fixture, published),
      /actual Vanilla exports/u,
    );
    await writeFile(resolve(published, 'Program.cs'), 'source leaked');
    await assert.rejects(
      assertPublishedOnlyBlazorApplication(published),
      /C# source/u,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
