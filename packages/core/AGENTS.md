# Core package rules

- Keep this package protocol-, browser-, Playwright-, and Node-filesystem-
  independent. `pnpm boundaries:check` and the DOM-free TypeScript config are
  mandatory guards, not substitutes for review.
- Model stable Bluetooth-domain concepts without exposing CDP or Playwright
  types, command names, IDs, or lifecycle objects.
- Prefer immutable values and explicit validation at public boundaries. Use
  `Uint8Array` for byte payloads.
- Do not add global mutable state.
- Cover domain behavior with deterministic pure unit and type tests.
