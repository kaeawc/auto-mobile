# Windows & Linux installer signing (research)

Companion to [`apple-signing-setup.md`](./apple-signing-setup.md). That doc covers
the macOS DMG path, which is fully wired in
[`build-desktop-app-installers.yml`](../../.github/workflows/build-desktop-app-installers.yml)
(Developer ID sign during Compose packaging → `notarytool` → staple). The **MSI
and `.deb` produced by that same workflow are currently unsigned.** This doc
researches what it takes to sign them, how much of the Apple mental model carries
over, and what is worth doing.

It contains **no secret values**. Every identifier is a placeholder.

## TL;DR

| Platform | Is signing needed? | Recommended path | Cost | Effort |
| --- | --- | --- | --- | --- |
| **Windows (.msi)** | **Yes** — unsigned installers trip SmartScreen "unknown publisher" and scare users off | **Azure Trusted Signing** (a.k.a. Azure Artifact Signing) via **`jsign`** | ~$10/mo | Moderate — identity validation + service principal + one workflow step |
| **Linux (.deb)** | **Mostly no** — `dpkg`/`apt` do not verify per-package signatures by default | **Detached GPG signature + SHA256 checksum** next to the release asset; skip `dpkg-sig` | $0 | Low |

The single thing worth real effort is **Windows**. Linux is a checksum-and-optional-GPG
formality unless/until we host an apt repository.

---

## The mental-model shift from Apple

Your Apple setup rests on a pattern that **does not transfer** to Windows anymore:
generate a cert, export a `.p12` that contains the private key, base64 it, drop it
in a GitHub secret, re-import into an ephemeral keychain in CI.

Since **June 2023 the CA/Browser Forum requires every Windows code-signing
private key to live on FIPS 140-2 hardware** (HSM or USB token). CAs no longer
issue a downloadable `.pfx`/`.p12` for code signing. So the "cert-in-a-secret"
approach is dead for Windows — the private key is either on a physical token you
plug into a machine (useless for CI) or in a cloud HSM you authenticate to.

What each platform's trust story actually is:

| Concept | macOS (what you built) | Windows | Linux (.deb) |
| --- | --- | --- | --- |
| Signing authority | Apple Developer ID cert | Authenticode cert (OV/EV) **or** Azure Trusted Signing | Your own GPG key (self-issued) |
| Where the key lives | `.p12` you own → CI keychain | **Cloud HSM only** (hardware mandate) | Anywhere (a GPG secret key) |
| "Prove it to the OS" step | **Notarization** (`notarytool submit --wait`) | **No notarization** — nothing to submit | Nothing |
| Reputation gate | Gatekeeper (binary yes/no once notarized) | **SmartScreen** — earned via install telemetry over time | none (verification is opt-in) |
| Analog of "stapling" | staple ticket to DMG | none | none |

Two things to internalize:

1. **There is no Windows notarization.** You sign, and that's it. There is no
   submit-and-wait API. The Apple `notarytool` step has no counterpart.
2. **SmartScreen reputation is earned, not granted.** Even a perfectly signed
   installer can show "Windows protected your PC" until the signing *identity*
   accumulates enough clean installs. This is the real user-facing pain, and no
   amount of signing removes it instantly (see EV vs. Trusted Signing below).

---

## Windows: the options

### Why sign at all

An unsigned `.msi` downloaded from a GitHub release shows a yellow/blue
SmartScreen "Windows protected your PC — unknown publisher" prompt, and the UAC
dialog says *Publisher: Unknown*. Most non-technical users abandon at that screen.
Signing replaces "Unknown" with "AutoMobile" (your validated identity) and, once
reputation builds, removes the SmartScreen interstitial.

### Option A — Azure Trusted Signing / Azure Artifact Signing  ✅ recommended

Microsoft's cloud signing service (renamed **Azure Artifact Signing** in 2026;
still widely called **Trusted Signing**). Certs are cloud-hosted, short-lived
(~3 days), and chain to a Microsoft-operated, publicly-trusted root.

- **Cost:** Basic tier **$9.99/mo** (up to 5,000 signatures); Premium $99.99/mo.
- **No hardware token, no `.pfx`.** Satisfies the hardware mandate because the key
  is in Microsoft's HSM. This is the whole reason it exists.
- **Reputation is identity-based, not per-certificate.** The 3-day cert lifetime
  is irrelevant to SmartScreen — reputation accrues against your validated
  publisher identity across every build. New intermediate CAs occasionally reset
  reputation briefly (a known, reported wrinkle), but the trend is upward with
  real installs.
- **Eligibility (the catch):** available to organizations/individuals in **US,
  Canada, EU, UK**. It is now **open to self-employed individuals** in GA — the
  "3 years of verifiable business history" requirement was a *public-preview*
  restriction and has been dropped. You verify identity once (this is a real
  KYC-style step with lead time — plan for it). Given you sign as
  `dev.jasonpearson.*`, you'd validate as a self-employed individual.
- **CI mechanics:** authenticate with an Azure **service principal** (tenant +
  client id + client secret, or OIDC), then sign with **`jsign`** — which has
  **native `TRUSTEDSIGNING` support** and runs on any OS (no `signtool`, no
  Windows-only tooling):

  ```bash
  # --keystore: the account endpoint (== TRUSTED_SIGNING_ENDPOINT); <region> e.g.
  #   weu / eus. jsign also accepts the bare host without the https:// scheme.
  # --storepass: an AAD access token for the service principal (az login / OIDC)
  # --alias: "<account-name>/<cert-profile-name>"
  jsign --storetype TRUSTEDSIGNING \
        --keystore "https://<region>.codesigning.azure.net" \
        --storepass "$ACCESS_TOKEN" \
        --alias "<account-name>/<cert-profile-name>" \
        AutoMobile-<version>-windows.msi
  ```

  `jsign` is a single self-contained jar (already Java — fits this repo's toolchain
  and our "prefer an existing mechanism" rule; no new native dependency). It can
  run in the **existing `windows-latest` matrix leg right after `packageMsi`**, or
  even on the Linux leg since it's cross-platform.

- **Alternative front-end:** Microsoft's official `azure/trusted-signing-action`
  (wraps `signtool`, Windows-only). Works, but `jsign` is one jar, OS-agnostic,
  and mirrors how we already prefer JVM tooling — I'd lead with `jsign`.

### Option B — Traditional OV/EV certificate on a cloud HSM

Buy an Authenticode cert from a CA (DigiCert, SSL.com, Sectigo, Certum…) and host
the key in a cloud HSM (DigiCert KeyLocker, SSL.com eSigner, Azure Key Vault).
`jsign` supports all of these (`DIGICERTONE`, `ESIGNER`, `AZUREKEYVAULT`, …).

- **OV cert:** ~$200-400/yr, **still has to build SmartScreen reputation from
  zero** — same slow ramp as Trusted Signing, but pricier and more setup.
- **EV cert:** ~$300-700/yr, **instant SmartScreen reputation** (the one real
  advantage), but requires organization validation (hard/awkward as a sole
  individual) and a hardware/HSM story.

Only worth it if you specifically need **day-one SmartScreen silence** and can
validate as an organization. For a solo maintainer shipping a dev tool,
**Trusted Signing at $10/mo wins** on cost, setup, and the no-token requirement.

### Recommendation for Windows

**Azure Trusted Signing + `jsign`, signing the MSI inside the reusable
`build-desktop-app-installers.yml` `windows` matrix leg** — the same leg the
macOS DMG is signed in. That workflow is what `prepare-release.yml` runs to build
the release candidates, and `release.yml` reuses those exact artifacts without
rebuilding (see below), so signing must happen at build time in that matrix, not
as a release-only step.

Refinement worth noting: signing only the outer `.msi` leaves the bundled
launcher `.exe` and JVM runtime inside unsigned. For best SmartScreen behavior
the ideal is **sign the jpackage app-image `.exe` first, then package, then sign
the `.msi`**. Compose's `nativeDistributions` doesn't cleanly expose that
intermediate app-image step, so v1 can sign just the MSI (the file users actually
launch) and we can revisit inner-binary signing if SmartScreen stays sticky.

### Likely new CI secrets (Windows)

Analogous to the Apple eight, but Azure-shaped:

| Secret | What it is |
| --- | --- |
| `AZURE_TENANT_ID` | AAD tenant of the Trusted Signing account |
| `AZURE_CLIENT_ID` | service principal app id |
| `AZURE_CLIENT_SECRET` | service principal secret (or use OIDC and drop this) |
| `TRUSTED_SIGNING_ENDPOINT` | e.g. `https://weu.codesigning.azure.net` |
| `TRUSTED_SIGNING_ACCOUNT` | Trusted Signing account name |
| `TRUSTED_SIGNING_PROFILE` | certificate profile name |

(Endpoint/account/profile aren't secret, but keeping them as secrets/vars matches
the existing pattern and avoids leaking the account name.)

---

## Linux: the `.deb` reality

Linux is **not** a third code-signing platform in the Windows/macOS sense.

- **`dpkg`/`apt` do not verify per-package GPG signatures by default.** The
  embedded-signature feature (`debsig-verify`) is `no-debsig` out of the box, and
  virtually no user has configured it. Signing the `.deb` itself with `dpkg-sig`
  is therefore **cosmetic for direct downloads** — nobody's machine checks it.
- **What Linux actually trusts is the *repository*.** `apt` verifies the GPG
  signature on the repo's `Release`/`InRelease` metadata, and the package hashes
  chain from there. That only applies if we host an **apt repository** — we don't;
  we ship the `.deb` as a direct GitHub-release download.

So for our current "download the `.deb` from the release page" model:

### Recommendation for Linux

1. **Publish a SHA256 checksum** for the `.deb` (integrity — cheap, universally
   useful). We already do checksum work elsewhere in the release; reuse it.
2. **Optionally publish a detached GPG signature** (`AutoMobile-<v>-linux.deb.asc`)
   from a self-generated project GPG key, so the security-conscious can
   `gpg --verify`. The public key goes in the repo / release notes.
   - Key is **self-issued and free** — no CA, no HSM, no cost. Store the private
     key + passphrase as GitHub secrets (`LINUX_GPG_PRIVATE_KEY`,
     `LINUX_GPG_PASSPHRASE`), import in CI, then sign **noninteractively** —
     plain `gpg --detach-sign` on a headless runner launches pinentry and dies
     with `Inappropriate ioctl for device`. Feed the passphrase on a file
     descriptor (never in argv):
     ```bash
     printf '%s' "$LINUX_GPG_PASSPHRASE" | gpg --batch --yes \
       --pinentry-mode loopback --passphrase-fd 0 \
       --armor --detach-sign AutoMobile-<version>-linux.deb
     ```
3. **Skip `dpkg-sig`/`debsigs` embedded signing** — high-friction, near-zero
   real-world verification.
4. **Defer apt-repo signing** until we actually stand up an apt repo. *That* is
   the point where GPG signing becomes load-bearing (signing `Release`), and it's
   a separate project from installer signing.

Net: Linux needs, at most, a **free GPG key and a `--detach-sign` step**, not a
signing-authority relationship.

---

## Suggested implementation shape (fits the existing workflow)

Crucially, the desktop installers follow the repo's **"prepare builds, release
reuses"** provenance model: `prepare-release.yml` runs
`build-desktop-app-installers.yml` to produce the `automobile-desktop-{macos,
windows,linux}` artifacts, and `release.yml` **downloads those exact artifacts by
`prepare_run_id` and attaches them — it never rebuilds or re-signs** (its header:
"consumes those exact artifacts rather than starting a second, potentially
different build"). So every signing step must live in the reusable workflow's
per-OS matrix leg, exactly where macOS already signs — not in `release.yml`, which
would otherwise publish the unsigned prepared artifact or need a second build that
breaks provenance.

The matrix already has per-OS legs. Additions, mirroring the macOS leg (which
signs whenever its secrets are present):

- **`windows` leg:** after `packageMsi` → **`jsign --storetype TRUSTEDSIGNING`**
  step (needs the 6 Azure secrets above, plumbed through `prepare-release.yml`
  like the Apple secrets already are). Cross-platform jar, so it can also run on
  the Linux leg if we'd rather keep signing off the Windows runner.
- **`linux` leg:** after `packageDeb` → the `gpg … --detach-sign` step (2 secrets)
  + emit `.sha256`. Upload the `.asc`/`.sha256` alongside the `.deb` so they ride
  the same artifact into `release.yml`.
- **`macos` leg:** unchanged (already signed + notarized in-leg).

The signed installer becomes the uploaded candidate, so `release.yml` publishes it
unchanged. Since `build-desktop-app-installers.yml` is `workflow_call`-only (run by
`prepare-release.yml`, never on PRs or forks), the new secrets are only ever needed
on the release path.

---

## Open decisions for Jason

1. **Trusted Signing eligibility / geography** — are you validating as a
   US-based self-employed individual? That determines whether Option A is open to
   you and sets the identity-validation lead time (do this first; it's the long
   pole).
2. **Day-one SmartScreen** — do we care about zero warnings on the very first
   release (→ EV cert, org validation, more $) or is a reputation ramp acceptable
   (→ Trusted Signing)? For a dev tool audience, a ramp is usually fine.
3. **Linux ambition** — checksum-only, or checksum + detached GPG now, with an
   apt repo as a later, separate effort?

---

## Sources

- [Code signing options for Windows app developers — Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Authenticode in 2025 – Azure Trusted Signing — text/plain (Eric Lawrence)](https://textslashplain.com/2025/03/12/authenticode-in-2025-azure-trusted-signing/)
- [Trusted Signing is now open for individual developers (Public Preview) — Microsoft Community Hub](https://techcommunity.microsoft.com/blog/microsoft-security-blog/trusted-signing-is-now-open-for-individual-developers-to-sign-up-in-public-previ/4273554)
- [Trusted Signing / Azure Artifact Signing — Pricing](https://azure.microsoft.com/en-us/pricing/details/trusted-signing/)
- [jsign — Java Authenticode signing tool (GitHub)](https://github.com/ebourg/jsign) · [jsign docs (storetypes incl. `TRUSTEDSIGNING`)](https://ebourg.github.io/jsign/)
- [Code Signing with Azure Trusted Signing on GitHub Actions — Hendrik Erz](https://hendrik-erz.de/post/code-signing-with-azure-trusted-signing-on-github-actions)
- [How to code sign Windows installers with an EV cert on GitHub Actions — Melatonin](https://melatonin.dev/blog/how-to-code-sign-windows-installers-with-an-ev-cert-on-github-actions/)
- [SmartScreen reputation for Windows app developers — Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Azure Trusted Signing short-lived certificate / reputation — Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/2202247/azure-trusted-signing-short-lived-certificate)
- [HOWTO: GPG sign and verify deb packages and APT repositories — Packagecloud](https://blog.packagecloud.io/how-to-gpg-sign-and-verify-deb-packages-and-apt-repositories/)
- [Package signing in Debian — Securing Debian Manual §7.5](https://www.debian.org/doc/manuals/securing-debian-manual/deb-pack-sign.en.html)
