# Compatibility and support

## What is tested

| Area                                 | Supported                                  | Tested                                                                            |
| ------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------- |
| Playwright                           | Peer range `>=1.65.0 <2.0.0`               | 1.65.1 only; other versions in the range run as `unverified`                      |
| Node.js                              | 22 or newer (`engines`)                    | 26.11.1 in CI; the quick start also passed in a manual run on 22.23.5 and 24.22.3 |
| Browser                              | Chromium through the native CDP backend    | Bundled headless Chromium 159.0.8154.6, CDP 1.3                                   |
| Operating system                     | Linux (with a launch flag) and macOS arm64 | Ubuntu 24.04 in CI; macOS is not run in CI                                        |
| Headed mode, channels, custom builds | Not validated                              | No Chrome or Edge channel or headed-mode coverage                                 |
| Windows and other platforms          | Unverified                                 | Not run in CI                                                                     |
| TypeScript in consumer projects      | 5.9.3 and 6.0.3                            | 6.0.3 and 5.9.3, `strict` with `skipLibCheck: false`                              |
| Notifications                        | Subscribe/unsubscribe handshakes           | Notification values cannot be injected                                            |
| Secondary services, full BLE stack   | Not supported                              | Rejected, never converted to primary services                                     |

## Browser and Playwright

The validated combination is Playwright 1.65.1 with its bundled
`HeadlessChrome/159.0.8154.6`, browser version `159.0.8154.6` and CDP protocol
version `1.3`, launched with `headless: true`. These values live in the
[compatibility constants](../packages/playwright/src/compatibility.ts).

On Linux, Chromium needs `--enable-features=WebBluetooth`; the
[quick start](quick-start.md) shows the configuration. macOS exposes Web
Bluetooth without the flag. Headed Chromium, browser channels and custom
executables are not covered.

The Playwright peer range is an installation contract, not a support claim. It
lets a project move to a newer Playwright 1.x release without a peer-dependency
conflict. When the browser, protocol or headless mode differs from the
validated combination but every required capability is present, GattLab runs
the test as `unverified`: it adds a `gattlab-compatibility` annotation to the
Playwright report and records the mismatch in the diagnostic timeline. A
browser without the required protocol domains fails the capability probe;
a change inside those experimental domains can instead surface later as an
operation failure.

Before a lab is created, the capability probe:

- confirms the Playwright browser is Chromium and reads `Browser.getVersion`;
- tells an insecure page apart from a secure page without `navigator.bluetooth`;
- enables, then disables, `BluetoothEmulation` and `DeviceAccess` on their
  required session targets.

A missing Linux feature flag fails with a message that names the launch
argument. Missing capabilities, an insecure page and non-Chromium browsers are
always errors. A successful probe returns the browser product and version, the
protocol version and a frozen operation snapshot, in which secondary services
and notification payload injection are reported as unsupported. On a passing
test the fixture attaches only `gattlab-capabilities.json`; the timeline,
summary and device artifacts are attached on an unexpected failure or with
`artifacts: 'always'`.

Chromium's emulation protocol has no command for pushing a characteristic
value, so notification payloads cannot be injected. See
[notification limitations](protocol-limitations.md#characteristic-writes-and-subscriptions).

## TypeScript

The packages are built with TypeScript 6.0.3. Their published declarations are
checked from a clean installed project with TypeScript 6.0.3 and TypeScript
5.9.3,
using `skipLibCheck: false`. Compilers older than 5.9.3 are not supported.

The repository stays on TypeScript 6.0.3 because its typed lint rules and its
package-boundary checker use the TypeScript 6 JavaScript compiler API. It will
move to a newer compiler once typed-lint support and an equivalent
programmatic API are available.

## Sample applications

The samples have their own pinned toolchains. None of them is a runtime
dependency of GattLab or a promise about other framework versions.

- The [Vanilla TypeScript sample](../examples/vanilla-ts/README.md) gets its
  Web Bluetooth types only from `@types/web-bluetooth` 0.0.22 and compiles with
  both TypeScript versions.
- The [React sample](../examples/react/README.md) uses React and React DOM
  19.3.1, their types 19.3.0, Vite 8.3.8 and `@vitejs/plugin-react` 6.3.0.
  Vite 8.3.8 includes the fix for
  [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm).
  Production and development builds are tested separately, the latter
  including a StrictMode journey.
- The [Blazor WebAssembly sample](../examples/blazor-wasm/README.md) pins
  .NET SDK 10.0.401, target `net10.0` and WebAssembly framework 10.0.10 in its
  own directory, with locked NuGet restore. .NET is needed only to build that
  sample; `pnpm validate` runs without it.

Each sample's tests run against the packed packages installed into a separate
project, on the validated Chromium. [tools/README.md](../tools/README.md)
describes the checks.

## Development toolchain

| Component           | Version      | Notes                                                                               |
| ------------------- | ------------ | ----------------------------------------------------------------------------------- |
| Node.js             | 26.11.1      | Enforced through `.node-version`, `engines` and `.npmrc`                            |
| pnpm                | 12.11.2      | Produces the lockfile                                                               |
| TypeScript          | 6.0.3        | Consumer declarations also checked with 5.9.3                                       |
| `@types/node`       | 26.6.6       |                                                                                     |
| Playwright          | 1.65.1       | Browser revision 1255                                                               |
| Chromium            | 159.0.8154.6 | Source revision `98a2592026af8d673b9fa83b626ac68bdf4ae78a`                          |
| `devtools-protocol` | 0.0.1674729  | Protocol types for the CDP mapping                                                  |
| ESLint              | 10.15.0      | With `typescript-eslint` 8.72.2, `eslint-plugin-jsdoc` 65.4.7 and `globals` 17.14.0 |
| Prettier            | 3.10.1       |                                                                                     |
| `publint`           | 0.3.25       | Package export checks                                                               |
| Vitest              | 5.1.0        | Unit tests                                                                          |

All dependency versions are exact, and the root pnpm lockfile is the source of
truth for installation. `pnpm validate` and `pnpm blazor:validate` run the full
checks; CI runs both on Ubuntu 24.04 for pushes to `main` and for pull
requests.

## References

- Node release status: <https://nodejs.org/en/about/previous-releases>
- Node 26.11.1 release: <https://nodejs.org/en/blog/release/v26.11.1>
- pnpm 12 release notes: <https://github.com/pnpm/pnpm/releases/tag/v12.0.0>
- TypeScript 7.0 release and API transition:
  <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>
- Vitest 5.0 release: <https://vitest.dev/blog/vitest-5.html>
- Chrome Web Bluetooth automation on Linux:
  <https://developer.chrome.com/blog/test-web-bluetooth-with-puppeteer>
