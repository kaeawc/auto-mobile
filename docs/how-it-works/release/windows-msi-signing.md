# Windows MSI signing

The Windows desktop installer is Authenticode-signed with Azure Trusted Signing on the
`windows-latest` leg of `build-desktop-app-installers.yml`. Background:
[Windows MSI signing with Azure Trusted Signing](../../devlog/2026-11-15-windows-msi-trusted-signing.md).

## Pipeline

1. `:desktop-app:packageMsi` builds the `.msi`.
2. `Sign Windows MSI` runs `scripts/ci/sign-windows-msi.sh` on it:
   - downloads the pinned jsign jar and checks its SHA-256;
   - requests an Entra ID token for scope `https://codesigning.azure.net/.default` with the
     client-credentials grant;
   - runs `jsign --storetype TRUSTEDSIGNING --keystore <region>.codesigning.azure.net
     --alias <account>/<profile>` with an RFC 3161 timestamp from
     `http://timestamp.acs.microsoft.com`;
   - writes `signed=true` or `signed=false` to the step output.
3. `Verify Windows MSI signature` runs only when `signed=true`. It fails unless
   `Get-AuthenticodeSignature` reports `Valid` and a timestamp.
4. `Stage installer` copies the signed file to `AutoMobile-<version>-windows.msi`.

The client secret reaches curl on stdin (`client_secret@-`). The token is masked and reaches jsign as
`--storepass env:TRUSTED_SIGNING_TOKEN`, so neither appears on a command line.

## Secrets

`prepare-release.yml` forwards these repository secrets. All six are optional in the reusable
workflow:

| Secret                     | Value                                                      |
| -------------------------- | ---------------------------------------------------------- |
| `AZURE_TENANT_ID`          | Entra ID tenant of the service principal                   |
| `AZURE_CLIENT_ID`          | Service principal application (client) ID                  |
| `AZURE_CLIENT_SECRET`      | Service principal client secret                            |
| `TRUSTED_SIGNING_ENDPOINT` | Account endpoint, `https://<region>.codesigning.azure.net` |
| `TRUSTED_SIGNING_ACCOUNT`  | Trusted Signing account name                               |
| `TRUSTED_SIGNING_PROFILE`  | Certificate profile name                                   |

| Secrets set | Result                                          |
| ----------- | ----------------------------------------------- |
| None        | Warning annotation; the MSI ships unsigned.     |
| Some        | The step exits 2 and names the missing secrets. |
| All         | The MSI is signed, then verified.               |

## Setup

1. In Azure, create a Trusted Signing account and complete identity validation (individual
   or organization).
2. Create a Public Trust certificate profile on the account.
3. Create an app registration (service principal) with a client secret. On the account, give
   it the `Trusted Signing Certificate Profile Signer` role.
4. Add the six secrets above to the repository.
5. Run `prepare-release.yml`. Check that the Windows leg logs `Signed ... with Azure Trusted
   Signing profile` and that `Verify Windows MSI signature` passes. Install the MSI on Windows
   and check that the UAC prompt shows the validated publisher.

## Renewal

Trusted Signing issues short-lived certificates per signature, and the RFC 3161 timestamp keeps
signed MSIs valid after a certificate expires, so there is no certificate to renew. Rotate
`AZURE_CLIENT_SECRET` before the app registration secret expires. Identity validation is
renewed in the Azure portal when Azure asks for it.

## Limits

Only the outer `.msi` is signed. The jpackage launcher `.exe` and bundled runtime inside it are
not. SmartScreen reputation builds from install telemetry after release.
