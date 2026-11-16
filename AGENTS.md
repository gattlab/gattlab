# GattLab contributor and agent guidance

Read README, ARCHITECTURE, the relevant API/limitation guide and package-local
AGENTS before changing code. Work on the requested scope and preserve unrelated
local changes. Explain the problem, resulting behavior and exact validation.

## Architecture and browser contracts

- Core must not import Playwright, CDP, browser globals or Node filesystem APIs.
- Raw browser protocol command/event names belong only in packages/cdp and
  maintained protocol-contract tools. Upper layers depend on public exports.
- One active lab owns the adapter per Chromium process. Contexts do not isolate
  adapters; independent simultaneous state requires independent processes.
- Avoid global mutable state outside the explicit process-keyed lease registry.
- Experimental protocol behavior requires a real pinned-Chromium contract;
  fake sessions alone prove adapter logic, not browser support.
- Native notification payload injection is unsupported. Keep capability,
  compatibility and limitation claims aligned with demonstrated behavior.

## Lifecycle and public API

Arm listeners before triggers. Use deterministic queues, observable events and
explicit deadlines; never arbitrary sleeps or waitForTimeout to repair races.
Await teardown before releasing a context/process lease. Preserve first error
causes, copied immutable context and payload redaction. Never retry an operation
whose effects are uncertain without an explicit public contract.

Public API changes require tests and API documentation, plus a usage example
when behavior is non-obvious. Architectural changes need explicit review and
synchronized architecture/compatibility documentation. Avoid new frameworks,
backends and abstractions without a current requirement.

## Validation

Use the pinned Node/pnpm versions and frozen dependencies. Start with the
narrowest checks relevant to the change; run the complete required validation
before accepting release-facing changes. The full commands are pnpm validate
and pnpm blazor:validate; the latter needs the sample-local pinned .NET SDK.
[tools/README.md](tools/README.md) describes the boundary, packaging,
documentation and installed-consumer checks. Preserve real compiler, browser,
artifact and cleanup checks. Report the commands you executed and their results,
and do not present unexecuted checks as passed.

Keep generated build output and diagnostic reports out of source commits.
Do not weaken failed tests, filter out failed attempts or silently alter
repeat counts/timeouts to obtain a pass. Keep tests proportional to the
change and preserve existing case identities and functional fixtures.

## Review and outward actions

Prepare reviewable changes and evidence before requesting approval. The owner
controls commits, pushes, tags, releases and registry publication; do not infer
a later action's approval from an earlier one. Never force-push, rewrite
published history, change visibility or publish packages without explicit
authorization. Independent review assesses the submitted evidence and scope.
