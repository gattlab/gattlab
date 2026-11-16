# Contributing to GattLab

## Issues welcome, pull requests not yet accepted

GattLab is maintained by one person while the API settles before 1.0, so it
does not currently accept external code or documentation pull requests. Bug
reports, feature requests and minimal reproductions are welcome as issues and
are the most useful way to help. Describe the user problem, expected behavior, supported browser
tuple and, where applicable, a minimal reproduction. A process for external
contributions may be introduced later; until then, unsolicited pull requests
may be closed without review.

Report suspected security issues through [SECURITY.md](SECURITY.md), rather
than a public issue containing exploit details or credentials.

## Building and testing locally

These notes help when building GattLab locally or working on a fork. Follow
[architecture](ARCHITECTURE.md), the [API contract](docs/api.md) and
package-local AGENTS guidance.

Use the Node and pnpm versions pinned in the repository and install with
`pnpm install --frozen-lockfile`. Start with checks relevant to your changes;
[tools guidance](tools/README.md) describes packaging, browser and resource
checks. The complete validation commands are `pnpm validate` and
`pnpm blazor:validate`; the latter requires the sample-local .NET SDK.

Keep changes focused. Public API changes need tests and documentation. Arm
listeners before triggering operations, use observable state instead of sleeps,
and await cleanup before releasing browser resources. Redact payloads from
shared diagnostics.
