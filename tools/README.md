# Repository tools

Run commands from the repository root with the pinned Node.js and pnpm versions.
`pnpm validate` runs every Node-based check below; `pnpm blazor:validate` adds
the Blazor sample and needs the .NET SDK pinned in `examples/blazor-wasm`. CI
runs both on Ubuntu 24.04.

## Source and packaging

- `pnpm boundaries:check` keeps the package layering intact: core imports no
  Playwright, CDP or browser globals, raw protocol names stay in `@gattlab/cdp`,
  and the sample applications use only the native Web Bluetooth API.
  `pnpm boundaries:test` checks the checker against deliberate violations.
- `pnpm packages:smoke` packs the three packages, checks their contents and
  manifests, runs publint and arethetypeswrong, installs them into a clean
  project without workspace links and compiles it with TypeScript 6.0.3 and
  5.9.3. `pnpm packages:test` covers the content checks it uses.
- `pnpm toolchain:smoke` confirms the exact Node.js, pnpm, TypeScript,
  Playwright, protocol and Chromium versions; `pnpm toolchain:test` covers it.
- `pnpm validation:test` checks that the validation scripts contain every gate
  and that lint, type and compiler failures are actually reported.
- `pnpm docs:check` verifies relative links and heading anchors in all
  Markdown files; `pnpm docs:test` covers it.

## Sample applications

Each probe builds a sample, installs the packed packages into a temporary
project outside the workspace, compiles its tests with both TypeScript versions
and runs them against Chromium. Each also runs one deliberately failing test to
confirm that the redacted GattLab attachments are produced and that your own
assertion stays the reported failure. Every server the probe starts must exit.

- `pnpm vanilla:probe` runs the Vanilla TypeScript scenarios three times in a
  row, plus the regression cases. `pnpm vanilla:build` only builds the app.
- `pnpm react:probe` runs reconnection, chooser cancellation, an ATT read error
  and a development-mode StrictMode journey against separate production and
  development builds. `pnpm react:test` runs its fast source checks.
- `pnpm blazor:probe` runs the published Blazor WebAssembly app.
  `pnpm blazor:test` checks the sample's source and CI wiring, and
  `pnpm blazor:validate` adds `dotnet format` verification.

## Lifecycle and protocol checks

- `pnpm command:counts` runs installed real-Chromium cases and fails if a public
  operation sends more CDP commands than expected. Its elapsed times are printed
  for information only. `pnpm command:capacity:test` covers the checker.
- `pnpm navigation:probe` checks what happens when a document that used Web
  Bluetooth is reloaded, navigated or closed: the adapter stays usable where
  Chromium keeps it, the lab fails with the documented terminal error where
  Chromium drops it, and cleanup still completes. `pnpm navigation:test` covers
  the checker. See the [terminal contract](../docs/api.md#terminal-lab-context).

The navigation and command-count probes write JSON summaries to
`test-results/`, which CI uploads as build artifacts. Their specs and
manifests live in `tools/protocol-probe/`.
