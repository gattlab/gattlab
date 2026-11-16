import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertReactApplicationBoundary,
  assertReactBrowserSource,
  assertReactSharedProfile,
  assertReactSourceBoundary,
} from './check-react-sample.mjs';

const session = `import { serviceUuid, ioCharacteristicUuid, writePayload } from '../../vanilla-ts/src/bluetooth-profile.js';
export async function connect() {
  const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [serviceUuid] }] });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(serviceUuid);
  const characteristic = await service.getCharacteristic(ioCharacteristicUuid);
  await characteristic.writeValueWithResponse(new Uint8Array(writePayload));
}`;
const main = `import { createRoot } from 'react-dom/client';
const root = document.getElementById('root'); createRoot(root).render(<App />);`;
const sources = {
  'index.html':
    '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
  'vite.config.ts':
    "import { defineConfig } from 'vite'; import react from '@vitejs/plugin-react'; export default defineConfig({ plugins: [react()] });",
  'src/main.tsx': main,
  'src/App.tsx': 'export function App() { return <p>Ready</p>; }',
  'src/bluetooth-session.ts': session,
};

async function withApplication(changes, run) {
  const root = await mkdtemp(join(tmpdir(), 'gattlab-react-source-'));
  try {
    for (const [local, source] of Object.entries({ ...sources, ...changes })) {
      const target = resolve(root, local);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('the actual React application and a minimal contract obey source guards', async () => {
  await assertReactApplicationBoundary(resolve('examples/react'));
  await withApplication({}, assertReactApplicationBoundary);
});

test('all testing boundaries apply to JS, TSX, HTML and Vite configuration', async () => {
  for (const source of [
    "import x from '@gattlab/core';",
    "import x from '@gattlab/playwright';",
    "import x from 'playwright';",
    "import x from '@playwright/test';",
    "import x from 'playwright-core';",
    "import x from '../../../tools/helper.js';",
    "import x from '../../../packages/core/src/index.js';",
    "import x from './test-helpers.js';",
    'const domain = "BluetoothEmulation";',
    'const domain = "DeviceAccess";',
  ]) {
    assert.throws(
      () => assertReactSourceBoundary(source, 'helper.tsx'),
      /cannot reference/u,
    );
    for (const local of ['src/hidden/helper.tsx', 'vite.config.ts'])
      await withApplication({ [local]: source }, async (root) => {
        await assert.rejects(
          assertReactApplicationBoundary(root),
          /cannot reference/u,
        );
      });
  }
  assertReactSourceBoundary(sources['vite.config.ts'], 'vite.config.ts');
});

test('every required DOM family and literal bracket member is rejected', () => {
  for (const source of [
    'document;',
    'window.document;',
    "globalThis['document'];",
    'node.querySelector("#battery");',
    'node.querySelectorAll("button");',
    'node.getElementById("status");',
    'node.textContent = "73%";',
    "node['textContent'] = '73%';",
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
    "node['setAttribute']('disabled', '');",
    'const view = <div dangerouslySetInnerHTML={{ __html: "73%" }} />;',
  ])
    assert.throws(
      () => assertReactBrowserSource(source, 'helper.tsx'),
      /React DOM ownership/u,
      source,
    );
  assertReactBrowserSource(
    "device.addEventListener('gattserverdisconnected', callback); device.removeEventListener('gattserverdisconnected', callback);",
    'bluetooth-session.ts',
  );
});

test('only the single main root lookup is exempt, including bracket access', () => {
  assertReactBrowserSource(main, 'main.tsx', { main: true });
  assertReactBrowserSource(
    main.replace('document.getElementById', "document['getElementById']"),
    'main.tsx',
    { main: true },
  );
  for (const source of [
    `${main}\ndocument.getElementById('other');`,
    main.replace("document.getElementById('root')", 'undefined'),
    main.replace('document.getElementById', 'window.document.getElementById'),
    `${main}\nwindow.document;`,
    `${main}\nroot.textContent = '73%';`,
  ])
    assert.throws(
      () => assertReactBrowserSource(source, 'main.tsx', { main: true }),
      /root lookup|DOM ownership/u,
    );
  assert.throws(
    () => assertReactBrowserSource(main, 'helper.tsx'),
    /DOM ownership/u,
  );
});

test('missing, dead, shadowed or reassigned profile imports cannot supply live calls', () => {
  assertReactSharedProfile(session, 'bluetooth-session.ts');
  for (const source of [
    session.replace('../../vanilla-ts/src/bluetooth-profile.js', './copy.js'),
    session.replace('import {', 'import type {'),
    session.replace('services: [serviceUuid]', 'services: [other]'),
    session.replace(
      'filters: [{ services: [serviceUuid] }]',
      'optionalServices: [serviceUuid], acceptAllDevices: true',
    ),
    session.replace(
      'getPrimaryService(serviceUuid)',
      'getPrimaryService(other)',
    ),
    session.replace(
      'getCharacteristic(ioCharacteristicUuid)',
      'getCharacteristic(other)',
    ),
    session.replace('new Uint8Array(writePayload)', 'new Uint8Array(other)'),
    `${session}\nfunction shadow(serviceUuid) { return serviceUuid; }`,
    `${session}\nfunction shadow({ writePayload }) { return writePayload; }`,
    `${session}\nserviceUuid = other;`,
    "import { serviceUuid, ioCharacteristicUuid, writePayload } from '../../vanilla-ts/src/bluetooth-profile.js';",
  ]) {
    assert.notEqual(source, session);
    assert.throws(
      () => assertReactSharedProfile(source, 'bluetooth-session.ts'),
      /canonical|profile/u,
    );
  }
  const renamed = session
    .replace(/\bserviceUuid\b/gu, 'profileService')
    .replace(
      'import { profileService,',
      'import { serviceUuid as profileService,',
    );
  assertReactSharedProfile(renamed, 'bluetooth-session.ts');
});

test('copied UUIDs and numeric payload forms fail without blocking native values', () => {
  for (const source of [
    "const uuid = '12345678-1234-5678-9abc-def123457000';",
    'const payload = [16, 32, 48];',
    'const payload = new Uint8Array([16, 32, 48]);',
    'const payload = Uint8Array.of(16, 32, 48);',
    "const payload = Uint8Array['of'](16, 32, 48);",
    'const payload = [0x10, 0x20, 0x30];',
    'const payload = [-1, 32];',
  ])
    assert.throws(
      () => assertReactBrowserSource(source, 'copied.ts'),
      /copied/u,
    );
  assertReactBrowserSource(
    'const values = []; const battery = value.getUint8(0); const payload = new Uint8Array(writePayload);',
    'native.ts',
  );
});

test('nested helpers, inline HTML and missing or symlinked required source cannot bypass checks', async () => {
  for (const [local, source, diagnostic] of [
    [
      'src/style.css',
      '.panel { --profile: "12345678-1234-5678-9abc-def123457000"; }',
      /copied UUID/u,
    ],
    ['src/dist/helper.tsx', "node['textContent'] = '73%';", /DOM ownership/u],
    ['helper.ts', 'node.innerText = "73%";', /DOM ownership/u],
    [
      'index.html',
      '<button onclick="this.innerText = 73">Read</button>',
      /inline DOM handlers/u,
    ],
    [
      'index.html',
      '<script>document.querySelector("#battery").textContent = "73%";</script>',
      /DOM ownership/u,
    ],
    [
      'src/hidden.js',
      'server.getPrimaryService(serviceUuid);',
      /native profile calls/u,
    ],
  ])
    await withApplication({ [local]: source }, async (root) => {
      await assert.rejects(assertReactApplicationBoundary(root), diagnostic);
    });
  await withApplication({}, async (root) => {
    const target = resolve(root, 'src/App.tsx');
    await rm(target);
    await assert.rejects(
      assertReactApplicationBoundary(root),
      /Missing handwritten/u,
    );
    await symlink(resolve(root, 'src/main.tsx'), target);
    await assert.rejects(
      assertReactApplicationBoundary(root),
      /cannot be a symlink/u,
    );
  });
});
