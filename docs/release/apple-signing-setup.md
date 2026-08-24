# Apple Developer ID signing & notarization (from scratch)

This document records how the macOS **ScreenCaptureKit helper** is code-signed
and notarized in CI, why each option was chosen, and what maintenance is due
before the certificate expires.

It contains **no secret values**. Every identifier below is a placeholder.

## What this signs, and why

AutoMobile distributes a prebuilt, universal macOS `screen-capture-helper` as a
**GitHub release asset** (not through the Mac App Store, and not via npm). macOS
Gatekeeper will refuse to run an unsigned / un-notarized binary downloaded from
the internet, so the release pipeline must:

1. **Code-sign** the helper with a **Developer ID Application** certificate
   (hardened runtime + secure timestamp), then
2. **Notarize** it with Apple via the App Store Connect API, waiting for
   `status: Accepted`.

Both are consumed by:

- [`.github/workflows/build-screen-capture-helper.yml`](../../.github/workflows/build-screen-capture-helper.yml)
  (called by both `prepare-release.yml` and `release.yml`)
- [`scripts/ios/setup-macos-signing-keychain.sh`](../../scripts/ios/setup-macos-signing-keychain.sh)
- [`scripts/ios/build-screen-capture-helper-release.sh`](../../scripts/ios/build-screen-capture-helper-release.sh)
- [`scripts/ios/sign-macos-products.sh`](../../scripts/ios/sign-macos-products.sh)
  (PR / merge / nightly Swift-package signing, via `swift-build.sh`)

## Options chosen (and the ones deliberately rejected)

| Decision point        | Chosen                                            | Why / what was rejected                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Membership            | Apple Developer Program, **individual**           | Developer ID certs + notarization both require a paid membership; a free Apple ID cannot create them.                                                                                                             |
| Certificate type      | **Developer ID Application**                      | It signs software for distribution **outside** the Mac App Store — exactly GitHub-release distribution. Rejected: _Apple Distribution / Mac App Distribution / Mac Installer Distribution_ (all App-Store-bound). |
| Installer cert        | **None** (`Developer ID Installer` not created)   | The helper ships as a **zipped bare executable** (`ditto -c -k`), not a `.pkg`/`.dmg` installer, so an installer cert is unnecessary. Add one only if distribution ever switches to a signed installer package.   |
| Intermediary (Sub-CA) | **G2 Sub-CA**                                     | Modern default, supported by Xcode 11.4.1+ (CI uses Xcode 26.x). Rejected: _Previous Sub-CA_ — a legacy escape hatch that **expires Feb 01, 2027**, a hard cliff; G2 gets the normal ~5-year validity.            |
| CSR origin            | Generated in **Keychain Access on the build Mac** | The private key must live in the login keychain so the `.p12` (cert **+ key**) can be exported for CI. A CSR made on another machine yields a cert with no usable private key locally.                            |
| Notarization auth     | **App Store Connect API key** (`.p8`)             | Key-based auth is the CI-friendly path (no Apple-ID password / 2FA prompts). Role **Developer** is sufficient for notarization.                                                                                   |
| Stapling              | **Not stapled**                                   | A standalone CLI executable cannot be stapled (stapling targets `.app`/`.pkg`/`.dmg`). Notarization is recorded server-side; Gatekeeper validates online. `status: Accepted` is the success signal.               |

## The eight CI secrets

Stored as GitHub Actions repository secrets. **Values are never committed.**

| Secret                                | What it is                                                             | Where it comes from                                            |
| ------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `MACOS_DEVELOPER_ID_CERT_BASE64`      | base64 of the `.p12` (Developer ID Application cert **+ private key**) | Keychain Access → export 2 items → `.p12`, then `base64`       |
| `MACOS_DEVELOPER_ID_CERT_PASSWORD`    | password set when exporting the `.p12`                                 | you choose it at export time                                   |
| `MACOS_KEYCHAIN_PASSWORD`             | throwaway password for CI's ephemeral keychain                         | any random string (e.g. `openssl rand -base64 24`)             |
| `MACOS_DEVELOPER_ID_SIGNING_IDENTITY` | exact identity string `Developer ID Application: <Name> (<TEAMID>)`    | `security find-identity -v -p codesigning`                     |
| `MACOS_DEVELOPER_ID_TEAM_ID`          | 10-char Team ID                                                        | Apple Developer → Membership (also inside the identity string) |
| `APPLE_NOTARY_KEY_ID`                 | App Store Connect API Key ID (10 chars)                                | App Store Connect → Integrations → API                         |
| `APPLE_NOTARY_ISSUER_ID`              | issuer UUID                                                            | same page, shown above the key list                            |
| `APPLE_NOTARY_PRIVATE_KEY_BASE64`     | base64 of the `.p8` API key                                            | downloaded once from App Store Connect, then `base64`          |

> **Important side effect:** `pull_request.yml`, `merge.yml`, and `nightly.yml`
> compute `MACOS_SIGNING_ENABLED = (secrets.MACOS_DEVELOPER_ID_CERT_BASE64 != '')`.
> The moment that secret is non-empty, those workflows begin signing the Swift
> packages in **strict mode**, which additionally needs
> `MACOS_DEVELOPER_ID_TEAM_ID`. **Set all eight together** or you fix the release
> job while reddening every PR/merge/nightly run.
>
> `sign-macos-products.sh` is the generic signing seam for macOS Swift-package
> apps. It signs no products right now (`XcodeCompanion` / `XcodeExtension` were
> removed), but `AXBridge` and any future macOS app should register a
> `sign_package` call there. The screen-capture helper is signed by its own
> release pipeline in `build-screen-capture-helper-release.sh`.

## Setup procedure (from scratch)

### 1. Certificate

1. **Keychain Access → Certificate Assistant → Request a Certificate From a
   Certificate Authority…** → enter your Apple ID email + a common name →
   **Saved to disk**. This writes the CSR and drops the matching private key
   into your login keychain.
2. [developer.apple.com/account → Certificates → +](https://developer.apple.com/account/resources/certificates/list)
   → **Developer ID Application** → **G2 Sub-CA** → upload the CSR → download the
   `.cer`.
3. Double-click the `.cer` to install it. Verify:
   ```bash
   security find-identity -v -p codesigning
   # -> 1) <HASH> "Developer ID Application: <Name> (<TEAMID>)"
   ```

### 2. App Store Connect API key

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
   → **Generate API Key**, role **Developer**.
2. **Download the `.p8` once** (unrecoverable afterward). Note the **Key ID** and
   the **Issuer ID**.

### 3. Export and encode

```bash
# In Keychain Access: select the Developer ID Application cert AND its private
# key -> right-click -> Export 2 items -> .p12 (set a password).
base64 -i ~/Desktop/developer-id.p12 -o ~/Desktop/developer-id.p12.b64
base64 -i ~/Downloads/AuthKey_<KEYID>.p8 -o ~/Desktop/notary-key.p8.b64
```

Store the original `.p12` (+ its password) and `.p8` (+ Key ID / Issuer ID) in a
password manager. **Never commit them.**

### 4. Prove it locally before touching CI

The build Mac's login keychain already holds the identity, so leave
`MACOS_KEYCHAIN_PATH` unset — the script then signs with the login keychain.

```bash
export MACOS_DEVELOPER_ID_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
export APPLE_NOTARY_KEY_ID="<KEYID>"
export APPLE_NOTARY_ISSUER_ID="<ISSUER-UUID>"
export APPLE_NOTARY_KEY_PATH="$HOME/Downloads/AuthKey_<KEYID>.p8"
./scripts/ios/build-screen-capture-helper-release.sh /tmp/screen-capture-helper-macos-universal.zip
```

Success looks like: `valid on disk` → `satisfies its Designated Requirement`
(codesign) then `status: Accepted` / `Processing complete` (notarization).

> Gotcha seen in practice: passing the literal placeholder `(TEAMID)` yields
> `... : no identity found`. The identity string must match
> `security find-identity` output **exactly**.

If notarization is rejected, read the log with the submission ID it printed:

```bash
xcrun notarytool log <submission-id> \
  --key "$APPLE_NOTARY_KEY_PATH" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID"
```

### 5. Load the eight secrets

```bash
gh secret set MACOS_DEVELOPER_ID_CERT_BASE64   --repo <owner>/<repo> < ~/Desktop/developer-id.p12.b64
gh secret set APPLE_NOTARY_PRIVATE_KEY_BASE64  --repo <owner>/<repo> < ~/Desktop/notary-key.p8.b64
gh secret set MACOS_DEVELOPER_ID_CERT_PASSWORD --repo <owner>/<repo>   # paste when prompted
gh secret set MACOS_KEYCHAIN_PASSWORD          --repo <owner>/<repo>
gh secret set MACOS_DEVELOPER_ID_SIGNING_IDENTITY --repo <owner>/<repo>
gh secret set MACOS_DEVELOPER_ID_TEAM_ID       --repo <owner>/<repo>
gh secret set APPLE_NOTARY_KEY_ID              --repo <owner>/<repo>
gh secret set APPLE_NOTARY_ISSUER_ID           --repo <owner>/<repo>
```

Then **shred the transit files** (secrets are stored server-side now):

```bash
rm -P ~/Desktop/developer-id.p12.b64 ~/Desktop/notary-key.p8.b64
```

Verify (expect 8 rows — 5 `MACOS_*` + 3 `APPLE_NOTARY_*`):

```bash
gh secret list --repo <owner>/<repo> | grep -E 'MACOS|APPLE_NOTARY'
```

### 6. Run the pipeline

Re-run the release workflow (or the failed jobs of a prior run):

```bash
gh run rerun <run-id> --failed --repo <owner>/<repo>
gh run watch <run-id> --repo <owner>/<repo> --exit-status
```

`build-screen-capture-helper` should sign + notarize (~1.5 min) and emit a
`sha256` output the `prepare` job consumes.

## Maintenance / renewal calendar

The credentials do not last forever. Track these:

> **Current certificate expiry: 2031-07-29** (issued 2026-07-28). Set a renewal
> reminder for **~2 months before**, i.e. late May 2031. Re-confirm the live date
> anytime with:
>
> ```bash
> security find-certificate -c "Developer ID Application" -p | openssl x509 -noout -enddate
> ```

- **Developer ID Application certificate — expires ~5 years after issue.**
  This is the hard deadline. The exact date is on
  [the certificates page](https://developer.apple.com/account/resources/certificates/list)
  (and in `security find-identity` output). **Before it expires:**
  1. Create a **new** Developer ID Application (G2) cert (steps 1–3 above). You
     can create the replacement while the old one is still valid — there is no
     forced gap.
  2. Re-export the `.p12` and refresh **`MACOS_DEVELOPER_ID_CERT_BASE64`**,
     **`MACOS_DEVELOPER_ID_CERT_PASSWORD`**, and — if the identity string
     changed — **`MACOS_DEVELOPER_ID_SIGNING_IDENTITY`**. Team ID is stable, so
     `MACOS_DEVELOPER_ID_TEAM_ID` does not change.
  3. Run step 4 locally to prove the new cert, then re-run a release.
  4. Do **not** revoke the old cert until the new one is proven — revocation can
     invalidate already-notarized artifacts' signing chain checks.
  - Apple limits the number of Developer ID Application certs per account; if you
    hit the cap when creating the replacement, revoke a genuinely-unused old one.

- **App Store Connect API key (`.p8`) — does not expire**, but:
  - It is **unrecoverable** if the stored copy is lost — you would generate a new
    key and refresh `APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER_ID`, and
    `APPLE_NOTARY_PRIVATE_KEY_BASE64`.
  - Rotate it if it is ever exposed (revoke in App Store Connect → generate a new
    key → refresh the three secrets).

- **Membership lapse** — if the paid Developer Program membership lapses, the
  certificate is invalidated and notarization stops working. Keep the annual
  renewal on the calendar.

- **Do not let the cert reach expiry silently.** A lapsed cert first surfaces as a
  red `build-screen-capture-helper` (and a red PR/merge/nightly signing step),
  not as a warning. Set a reminder ~2 months before the printed expiry date.
