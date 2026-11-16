# Changelog

## 0.1.0-beta.1 — 2026-11-16

- Packages declare `engines.node >=22` and npm `keywords`. Node.js 26.11.1 is
  the validated version; the quick start also passed in a manual run on
  Node.js 22.23.5 and 24.22.3. See [compatibility](docs/compatibility.md).
- Package READMEs link to the documentation with full GitHub URLs, so the
  links work on npm. The Markdown link check also verifies those URLs and
  rejects relative links in package READMEs.
- The notification limitation links to a tracking issue, and the contributing
  guide explains why pull requests are not accepted yet.
- No runtime code changes.

## 0.1.0-beta — 2026-11-16

- First beta, published on npm under the `beta` tag.
- The `@gattlab/playwright` peer range is now `@playwright/test >=1.65.0 <2.0.0`,
  so projects can upgrade Playwright within 1.x without a peer-dependency
  conflict. Validation is unchanged: only Playwright 1.65.1 with bundled
  headless Chromium 159.0.8154.6 is validated, and other capability-complete
  versions continue as `unverified`. See [compatibility](docs/compatibility.md).
- The README and [quick start](docs/quick-start.md) install the published npm
  packages instead of tarballs packed from source. The README now states the
  notification-payload limitation and compares GattLab with Puppeteer's
  Bluetooth emulation and `navigator.bluetooth` mocks.
- Documentation is rewritten for package users: the compatibility page lists
  what is supported and what is tested, and the protocol limitations describe
  current behavior on the validated browser.
- Removed internal release-process tooling (source export, repetition runner
  and their workflows) from the repository. CI keeps the build, unit,
  real-browser, package and sample checks, and now also checks Markdown links.
- No runtime code changes.

## 0.1.0-alpha.1 — 2026-11-15

- Validated browser baseline moved to Playwright 1.65.1 with bundled headless
  Chromium 159.0.8154.6 (CDP 1.3). The `@gattlab/playwright` peer range is now
  `>=1.65.0 <1.66.0`; the protocol contract suites passed unchanged on the new
  browser. See [compatibility](docs/compatibility.md).

## 0.1.0-alpha — 2026-11-15

First public prerelease of the source. The packages are not yet published to
npm; install them from tarballs packed from source as shown in the
[quick start](docs/quick-start.md). Release notes for a published npm version
will identify its exact supported baseline and package artifacts.

### Included behavior

- Playwright fixtures and a public `BluetoothLab` facade for deterministic
  Web Bluetooth tests against Chromium's virtual adapter.
- Stable peripheral, characteristic and descriptor handles, scripted operation
  queues and bounded journals.
- Native chooser, connection, discovery, read/write, subscription handshakes,
  cancellation, adapter state, disconnection and reconnect through installed
  package consumers.
- Terminal lab errors after confirmed adapter loss or uncertain partial model
  changes, retaining their original cause and requiring a fresh test fixture.
- Bounded redacted diagnostics and automatic Playwright attachments.
- Vanilla TypeScript, React and Blazor sample applications.

### Compatibility and limits

See [compatibility](docs/compatibility.md) for the current exact toolchain and
validated headless Chromium tuple. Package declarations are checked with
TypeScript 6.0.3 and 5.9.3.

Chromium's backend is experimental. Native notification payload injection is
unsupported, one lab owns the adapter per process, and GattLab does not simulate
radio conditions, pairing, bonding or the complete Bluetooth stack. See
[protocol limitations](docs/protocol-limitations.md).
