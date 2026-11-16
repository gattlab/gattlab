# CDP adapter rules

- Verify protocol shapes against the pinned `devtools-protocol` package and
  official CDP documentation.
- Keep all raw protocol command and event names in this package.
- Every new command/event mapping needs a fake-session unit test and a real
  Chromium contract test.
- Normalize protocol errors into core domain errors.
- Record command, response, and event timing in the timeline without exposing
  full payloads by default.
- Teardown must remove listeners, disable domains, detach sessions, and release
  the browser-process lease only after cleanup has been attempted.
- Never infer support from method names alone; capability probing and
  real-browser evidence are required.
