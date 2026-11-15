# Windows MSI signing with Azure Trusted Signing

- Kind: decision
- Date: 2026-11-15
- Source: #4725, research in #4819
- Shaped: [Windows MSI signing](../how-it-works/release/windows-msi-signing.md)

## Context

The desktop release pipeline (#4712) shipped the Windows `.msi` unsigned. Windows SmartScreen
warns on it and UAC shows *Publisher: Unknown*. Since June 2023 code-signing keys must live on
FIPS 140-2 hardware, so the Apple pattern of a `.p12` in a GitHub secret is not possible on
Windows. Windows has no notarization step, and SmartScreen reputation builds from install
telemetry.

## Options

1. Azure Trusted Signing: about $10 a month, cloud-hosted key, certificates chain to a
   Microsoft-trusted root, open to self-employed individuals in the US, Canada, EU and UK.
   Reputation is tied to the validated identity.
2. OV certificate: needs an HSM or token, costs more, and SmartScreen reputation ramps slowly.
3. EV certificate: immediate reputation, but needs organization validation and hardware, at
   3-7 times the cost.

## Decision

Option 1, signed with jsign. jsign is one cross-platform jar with a `TRUSTEDSIGNING` store type,
signs `.msi` files and needs no `signtool`. It runs after `:desktop-app:packageMsi` and before
the installer is staged. The reusable workflow has no `sign` input any more, so the secrets are
optional and gate the step: none set skips with a warning, a partial set fails.

## Consequences

- Releases ship an unsigned MSI until the Trusted Signing account, identity validation,
  certificate profile and service principal exist and the six secrets are loaded.
- Only the outer `.msi` is signed. Signing the jpackage launcher `.exe` first would need the
  Compose app-image step exposed; revisit if SmartScreen keeps warning after reputation should
  have built.
