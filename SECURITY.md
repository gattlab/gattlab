# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's private
vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**
(<https://github.com/gattlab/gattlab/security/advisories/new>). Do not put
exploit details, credentials, Bluetooth payloads or personal data in a public
issue or pull request.

Include the affected package/version or source commit, Node/Playwright/Chromium
versions, operating system, a minimal reproduction and expected impact. Use
synthetic devices and payloads where possible. Send only the information needed
to reproduce the issue; redact tokens and unrelated diagnostic data.

## Supported versions

Security maintenance targets the latest version published on npm under the
`alpha` tag and the current main branch; update older versions before checking
whether an issue is still present. Prereleases can change without a stable API
guarantee. A report
does not imply a fixed response deadline or a guaranteed fix schedule.

GattLab runs test applications against Chromium's experimental virtual
Bluetooth adapter. It is not a security boundary between untrusted code and
the host or between BrowserContexts sharing a browser process. See
[protocol limitations](docs/protocol-limitations.md) before relying on adapter
isolation or interpreting diagnostic availability results.
