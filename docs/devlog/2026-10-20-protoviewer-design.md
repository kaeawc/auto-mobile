# ProtoViewer design decisions

- Kind: decision
- Date: 2026-10-20
- Source: moved from `how-it-works/protoviewer.md`; #13625, #13829, #13616, #13617, #13618, #13619,
  #13620, #13621, #13622, #13623, #12518, #14539, #14540, #14542, #14144, #14180, #14159, #16516,
  #14803, #10563, #12251
- Shaped: [ProtoViewer](../how-it-works/protoviewer.md)

## Context

Epic #13625 set out a ProtoViewer app on iOS and Android to switch between, relaunch, share,
download and view any prototype that is a valid AutoMobile JSON SDUI spec. When the design was
accepted, the spec, validators, MCP `prototype` tool and per-platform saved-prototype paths already
existed.

- **Missing:** library UI, multi-prototype iOS viewer, import/export/share, opening a `.json` or URL, a
  physical iPhone path, an on-device list of Android saved prototypes.

Goals and non-goals for the first release:

Goals

1. Library: names and last opened; switch to any prototype in one tap.
2. Relaunch (restart from the spec) and Reset (relaunch plus clearing that prototype's storage).
3. Share: export a clean, validated `.automobile-proto` bundle through the system share sheet or a
   file.
4. Import: file open and share-sheet receive, with validation errors that name the path.
5. View: render with the existing renderers, offline, including saved storage and `via: "device"`
   requests.
6. MCP integration: `save` lands in the library, and an agent can open a given prototype.
7. The same experience on Android (Material 3) and iOS (SF Symbols).

Non-goals for the first release: spec migration or a `specVersion`, an editor, cloud sync or
accounts, a sharing service, Play Store or App Store listings, running arbitrary code (specs stay
declarative).

The envelope has no `specVersion`: the 2026-10-04 owner decision rejects older and newer shapes
instead of migrating.

## Options

Not recorded beyond the decisions below. Moving CtrlProxy's renderer into its own module was judged
one mechanical move: the `ctrlproxy/prototype` package imports only a few symbols from the rest of
CtrlProxy, so it was a rename plus three seams.

## Decision

| Question                   | Decision (owner, 2026-10-19)                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| iOS distribution           | Dev-signed builds on the owner's iPhones in the first release, alongside Android.                                               |
| Network for imported specs | One global switch, default off; per-host consent in Phase 2; MCP-direct `show` keeps today's behaviour.                         |
| Stores                     | GitHub releases only.                                                                                                           |
| LAN egress                 | RFC1918 LAN is allowed; loopback, link-local, `10.0.2.2` and the daemon ports stay blocked.                                     |
| iOS egress transport       | Network.framework (NWConnection) pinned transport (owner, 2026-10-21, #14540).                                                  |
| Missing referenced assets  | Reject the import on every platform with the offending path (owner, 2026-10-21, #14542).                                        |
| Android LAN permission     | Declare `ACCESS_LOCAL_NETWORK` + `INTERNET`, request on switch-on (owner, 2026-10-21, #14539).                                  |
| MCP-saved prototypes       | Follow the imported-prototype network policy.                                                                                   |
| Remote image URLs          | Count as network, same policy as `request`; https only outside dev (owner, 2026-10-31, #14180).                                 |
| Store identity             | `dev.jasonpearson.automobile.protoviewer` on both stores, `.dev` for dev builds, title ProtoViewer (owner, 2026-10-31, #14144). |
| Store accounts             | Personal enrollment on both stores; Play needs a 14-day closed test with 12 testers first (owner, 2026-10-31, #14144).          |
| Store support and privacy  | Hosted on the docs site: `protoviewer/support.md` and `protoviewer/privacy.md` (owner, 2026-10-31, #14144).                     |
| Version skew               | Host capability handshake before `save`, signer trust, store link, last 3 releases.                                             |
| Crash and quality signals  | Store vitals and Xcode Organizer plus Copy diagnostics; no crash SDK.                                                           |
| Rollout gates              | Halt above 1.09% crash or 0.47% ANR (Android), 1.09% crash (iOS) (owner, 2026-11-03, #16516).                                   |

## Consequences

Phased plan:

**First release.** Library list; open/switch; relaunch/reset; delete; share a clean bundle; import by
file or share sheet; MCP `save` routing and `open`; global network switch; shared hardening. Not
included: thumbnails, search, keep-both/replace, compact links, MCP export/import, per-host consent,
URL/QR import, universal links. Order: (1) corpus, strict zip reader, Swift validator in parallel with
(2) the Android extraction; then (3) Android app, (4) hardening, (5) MCP routing, (6) iOS app.

**Phase 2.** Per-host consent UI, URL import (https only, confirmation, egress check on the fetch), QR,
thumbnails, search, replace/keep-both, font opt-in. **Phase 3.** Store tracks, universal links, MCP
export/import, live attach for imported prototypes (off by default).

Risks:

1. Swift validator parity is the critical path (mitigated by reject-only scope and the corpus).
2. Library network policy differs from #12518's "no allowlist"; MCP-direct `show` is unchanged.
3. The extraction touches CtrlProxy (one mechanical change plus existing suites).
4. The adb-based MCP channel is Android-specific; iOS simulators use the filesystem and `simctl openurl`; physical-device delivery is later work.
5. With no `specVersion`, older apps reject newer specs; the capability handshake (section 7) and
   `requires` turn that into an update hint before anything is pushed.

Device test plan: Device (manual-test skill; Android API 37, iOS
27.x on the owner's iPhone): MCP save to library; switch among three; relaunch; reset; delete; share and
re-import across platforms; adb push plus VIEW import; invalid-spec error; offline with stored values;
localhost request blocked and LAN request allowed with the switch on.

Coverage-guided Jazzer/libFuzzer import-fuzzing harnesses and a nightly CI job were left as future
work.

Issues under epic #13625: Epic #13625: #13616 bundle format, #13617 Android extraction, #13618 Android app, #13619 iOS app,
#13620 validation parity, #13621 MCP routing and `open`, #13622 shared hardening, #13623 release
and CI.
