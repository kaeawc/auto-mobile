# Verifying iOS Photos full access

- Kind: decision
- Date: 2026-10-15
- Source: moved from `how-it-works/plat/ios/photos-full-access.md`; #12317, #12316, #12368, #12462,
  #12486, #12398, #12490
- Shaped: [iOS Photos full access](../how-it-works/plat/ios/photos-full-access.md)

## Context

`simctl privacy grant photos` stores a TCC row but did not give the app effective
`PHAccessLevelReadWrite` in the #12317 matrix (iOS 26.5, Xcode 26.6). The host had no channel that
reads the target app's PhotoKit status.

## Options

- **A. Query from the CtrlProxy/XCTest runner (rejected).** The runner (`XCTRunner`) has its own
  bundle identity, so it would return an authoritative-looking status for the wrong app. Whether it
  tracks the target's status on a simulator was unverified.
- **B. Instrumented probe app (recommended first step).** An app without the SDK (or the Playground)
  writes both levels' raw status to `Documents/` for the host to read. It observes the probe app, so it
  can anchor a support matrix and cold-restart persistence checks, but cannot verify another app.
- **C. In-app SDK status for integrated apps (follow-up, not implemented).** A
  `PhotosAuthorizationInspector` in `ios/auto-mobile-sdk` publishing the same JSON from the real
  target, letting `verifyPhotosGrant` return `verified: true` when the snapshot is fresh (no older than
  the last launch/foreground) and `readWrite.name == "authorized"`. Costs SDK API surface; helps only
  SDK apps. A real `PhotosAuthorizationVerifier` needs this.
- **D. Different TCC writes (unverified, not attempted).** Direct `TCC.db` inserts
  (`kTCCServicePhotos` `auth_value=3`, other `kTCCServicePhotosAdd` values) seemed unlikely to differ,
  since `photolibraryd` appears to keep state the row does not set, and `TCC.db` writes are unsupported
  and may break between runtimes. Also: granting after first launch or after a `photolibraryd` restart
  (the issue tried only before first launch), and additional iOS 17+ service names (the repo maps only
  two).

## Decision

Default to a non-fatal `PHOTOS_FULL_ACCESS_UNVERIFIED` after dispatch, with a typed
`PHOTOS_FULL_ACCESS_NOT_ESTABLISHED` failure when a verifier observes a non-authorized status, behind
an injectable verifier. Ship option B as the Playground probe. Planned order:

1. Use the probe as the independent reader for D and the cold-restart check.
2. Verify a sequence with the probe before claiming support for any simulator/runtime range.
3. Option C for SDK-integrated apps to allow a real `verified: true`.

For implied add-only readback (#12462), the iOS 27 runtime threshold was orchestrator-chosen (#12486).
Gating on the Photos row's `auth_version` (27.0 wrote 2, 26.5 wrote 1) was rejected as too indirect
and undocumented.

## Consequences

Device checks owed:

- Build and launch the Playground on a dedicated simulator and confirm the probe shows
  `notDetermined` for both levels on a fresh install.
- Repeat the grant matrix recording `readWrite`/`addOnly` per sequence plus a cold restart after the
  best one.
- Try grant-after-launch and a raw TCC write (D), recording Xcode and runtime versions.
