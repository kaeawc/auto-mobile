# Security policy

## Supported versions

Security fixes land on `main` and ship in the next release. Only the latest release of each
component is supported:

| Component                                                          | Supported      |
| ------------------------------------------------------------------ | -------------- |
| AutoMobile MCP server and CLI (npm, Homebrew, GitHub releases)     | latest release |
| ProtoViewer for Android and iOS (store builds and GitHub releases) | latest release |
| Android and iOS SDKs and control proxies                           | latest release |

## Reporting a vulnerability

Report privately through
[GitHub private vulnerability reporting](https://github.com/kaeawc/auto-mobile/security/advisories/new)
on this repository. Do not open a public issue or pull request for a suspected vulnerability.

Include the affected component and version, steps or a sample file that reproduces it, and the
impact you observed. For ProtoViewer import issues, attach the prototype bundle or JSON that
triggers it.

Response targets: acknowledgement within 7 days, an initial assessment within 14 days, and a fix
or mitigation plan within 30 days for confirmed issues. Fixes ship in a release with a published
advisory that credits the reporter unless you ask otherwise.

## Scope

In scope:

- **Prototype import** in ProtoViewer: the zip reader, JSON parser and validator that process a
  prototype file shared by someone else (path traversal, zip bombs, resource exhaustion, parser
  crashes, or validation bypass).
- **Egress filtering**: any way an imported prototype reaches an address the network policy blocks
  (loopback, link-local, AutoMobile daemon ports) or reaches the network while the setting is off.
- **Storage isolation** between prototype library ids, and between ProtoViewer and other apps.
- The AutoMobile MCP server, daemon and control proxies: unauthenticated access to device control,
  command injection, or privilege escalation.

Out of scope: vulnerabilities in third-party dependencies with no demonstrated impact on
AutoMobile (report those upstream), attacks that need a rooted or already-compromised device, and
denial of service from running your own prototypes on your own device.

## Third-party notices

ProtoViewer lists its open-source licenses in-app under Settings, "Open-source licenses". See
the [ProtoViewer design doc](docs/design-docs/protoviewer.md) for how they are generated.
