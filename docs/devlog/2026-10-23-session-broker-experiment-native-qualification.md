# Session broker native qualification

- Kind: concept
- Date: 2026-10-23
- Source: moved from `how-it-works/session-broker-experiment.md`; #15053, #13987
- Shaped: [Session-only provider experiment](../how-it-works/session-broker-experiment.md)

## Results (October 2026)

| Check                                       | Result                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| iOS zero pooling (iPhone 17 Pro / iOS 26.5) | passed: distinct UUIDs/UDIDs; acquire ~45-59 s, release ~16 s; second request got `capacity_exhausted` with no tools; replay of the refusal stayed terminal (`retryRequires: "new_request_id"`)                                                              |
| iOS clean-reuse contamination               | passed for files, app/global prefs, keychain item, Contacts grant, app removal; old connection got `broker_session_ended`. Reuse acquire 12-17 s, reset 50-152 s: no throughput benefit shown                                                                |
| iOS interrupted-reset recovery              | passed: daemon killed mid-`resetting`; restart destroyed the uncertain simulator, original request stayed `failed`/`session_owner_exited` incl. on replay                                                                                                    |
| iOS mixed-profile replacement               | passed: phone, tablet, phone with caps of 1; journal showed confirmed destruction before next create intent (gaps ~0.9 s)                                                                                                                                    |
| Android zero pooling (API 35 arm64)         | passed: coarse phone/tablet resolved to `medium_phone`/`medium_tablet`; AVD absent after release; serial `emulator-5556` reused across sessions (the transport serial is not a session identity). Does not cover Android clean reuse, ADB restart, Linux/KVM |
| Request abandonment (iOS)                   | passed: unknown, `acquiring`, and ready requests all reached terminal owner-bound receipts with exact native absence confirmed; late native claims are covered by deterministic tests                                                                        |

The measured clean reset spent ~15 s stopping, 0.3 s erasing, 52 s booting. Reset
isolates by rebooting an erased simulator, so an idle-pool hit moves boot work to
the preceding release rather than avoiding it. Keep zero pooling as the throughput
baseline until a matched comparison shows a benefit. Not run: native Android
two-session contamination and matched p50 timing. A Slack bundle that failed
simulator install with a copy-permission error installed from a staged copy with
readable directories and no xattrs/ACLs (contents identical). The disposable probe
uses simulator entitlement metadata rather than restricted entitlements in its ad
hoc host signature.

## Open work recorded with the contract

- RPC abort propagation: a request signal could stop only the caller's bounded wait.
- Changing `reportReleased` with no remembered bindings (it still reports confirmed settlement)
  needs separate binding-ownership and recovery tests.
- App installation and initial configuration need no Slack application SDK; folding them into the
  acquisition request is a later ergonomic change.
