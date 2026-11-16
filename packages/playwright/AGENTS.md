# Playwright integration rules

- Depend only on public exports from `@gattlab/core` and `@gattlab/cdp`; never
  duplicate raw CDP command or event mappings here.
- Associate fixture ergonomics, pages, chooser control, and artifacts with a
  BrowserContext while respecting the one-active-lab-per-browser-process lease
  documented in `docs/api.md` (Fixture and adapter).
- Arm chooser and protocol listeners before the user action that triggers
  `requestDevice()` or a GATT operation.
- Fixture teardown must await lab disposal before releasing the context.
- Test integration behavior against real Playwright and pinned Chromium;
  fake-session tests alone cannot establish browser support.
- Keep diagnostics actionable and redact or truncate Bluetooth payloads by
  default.
