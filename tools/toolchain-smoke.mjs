import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import process from 'node:process';

import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const expected = {
  node: 'v26.11.1',
  pnpm: '12.11.2',
  typescript: '6.0.3',
  playwright: '1.65.1',
  devtoolsProtocol: '0.0.1674729',
};

const packageManager = process.env.npm_config_user_agent
  ?.split(' ')[0]
  ?.split('/');

if (packageManager?.[0] !== 'pnpm') {
  console.error(
    'GattLab toolchain smoke must be run via `pnpm run toolchain:smoke`.',
  );
  process.exit(1);
}

const observed = {
  node: process.version,
  pnpm: packageManager[1],
  typescript: require('typescript/package.json').version,
  playwright: require('playwright/package.json').version,
  devtoolsProtocol: require('devtools-protocol/package.json').version,
};

assert.deepEqual(observed, expected);

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'linux' && {
      args: ['--enable-features=WebBluetooth'],
    }),
  });
  const session = await browser.newBrowserCDPSession();
  const browserVersion = await session.send('Browser.getVersion');
  await session.detach();

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        toolchain: observed,
        browser: browserVersion,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
