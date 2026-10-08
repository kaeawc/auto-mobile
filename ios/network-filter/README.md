# Simulator network filter

Backend for iOS Simulator `networkCondition` (#6298). It reports flow identity
and, since #10264, applies one condition: a leased **offline** rule for one
explicitly named app on one simulator. It cannot apply latency, bandwidth or
packet-loss rules (#10265). Simulator attribution, signed installation,
authenticated XPC at runtime, and network isolation still require native
integration evidence from the signed run (#10263).

## Current implementation

- macOS 13+ Swift containing-app/controller and `NEFilterDataProvider` system
  extension. macOS 13 is required for `sourceProcessAuditToken` and Foundation's
  per-connection code signing requirement API.
- Supported SystemExtensions activation and NEFilterManager configuration.
  Controller output distinguishes `installation_required`, `approval_required`,
  `unavailable`, and `ready`. Ready means the provider replied over
  authenticated XPC, not that any traffic behavior has been verified.
- Version 3 Codable/XPC snapshots and rule commands (version 1 and 2
  snapshots still decode).
  Both peers require an Apple-signed executable with the expected bundle
  identifier and their own signing team.
- With no active rule, every new socket flow receives `allow()` without any
  lookup. The callback copies audit tokens into a lock-protected history of at
  most 128 entries. It never reads payloads, records network addresses, or
  pauses a flow.
- Snapshots use Security's audit-token lookup for both source-app and
  source-process code metadata. Complete audit tokens retain process generation;
  bundle identifiers and PIDs are not interpreted as simulator identity.
  Missing/malformed tokens and failed metadata lookup remain unattributed.
- Per-simulator attribution (#10589) runs at snapshot time, never in the flow
  callback. `SimulatorFlowResolver` maps each flow's audit tokens to one
  simulator (device set and UDID), app executable and process generation (pid
  plus pid version, never the pid alone), through a fakeable `ProcessTable`
  (`DarwinProcessTable` uses `proc_pidpath_audittoken`, `proc_pidinfo`
  `PROC_PIDTBSDINFO`, `KERN_PROCARGS2`, and libbsm's `audit_token_to_pid` and
  `audit_token_to_pidversion`). Each flow reports `attribution`
  (`attributed`, `unattributed`, `conflicting`), `method` (`executable_path`,
  `launchd_sim_ancestor`, `unattributed`), `simulator`, `app`, and a `reason`
  when it is not attributed:
  - App processes: the UDID comes from an executable under
    `<deviceSet>/<UDID>/data/Containers/Bundle/Application/`.
  - Runtime-hosted helpers (`nsurlsessiond`, WebKit networking) share one path
    per runtime, so the resolver walks the parent chain to that simulator's
    `launchd_sim` and reads the device path from its arguments. A parent that
    started after its child (a reused pid) stops the walk.
  - Delegated flows attribute through `sourceAppAuditToken`. If the app and
    process tokens resolve to different simulators the flow is `conflicting`.
  - Only simulators the host names are selectable:
    `network-filter-controller status|snapshot --managed <device-set-path> <udid>`
    (repeatable). Device-set paths are resolved with `realpath` because the
    kernel reports executable paths with symlinks resolved. The default device
    set is never assumed. Native Mac processes, unmanaged simulators and every
    lookup failure are reported `unattributed` and allowed.
  These methods are hypotheses until the signed run in #10263 confirms them,
  including whether the sandboxed provider may read other processes' paths and
  `launchd_sim` arguments, and whether `launchd_sim` names a custom device set in
  the same (realpath) form the host passes.
- Restart discards the diagnostic history and every rule. There is no
  persisted impairment, delayed flow verdict, control-channel bypass, or
  target-app instrumentation.

### Leased per-app offline (#10264)

- `NetworkRuleStore` holds rules keyed by target (simulator device set and UDID
  plus bundle identifier). Each rule carries its owner (the host session), an
  owner generation (one per session binding) and a revision (one per command
  the owner sends). `apply`, `reset` and `renew` are idempotent per revision and
  answer with the installed revision:
  - `apply` installs or replaces the owner's rule. A re-delivered apply of the
    installed revision starts a fresh lease; an older revision or generation is
    `stale_revision`/`stale_generation`; another owner's active rule is
    `owned_by_another_session` and is left unchanged.
  - `reset` removes only the owner's rule and must carry a newer revision than
    the apply it removes. With no rule it still answers `reset`. It never clears
    another owner's rule.
  - `renew` extends the lease of the exact installed revision; anything else is
    `not_found` or stale, and the host stops renewing.
  - Removing a rule (reset, expiry, provider stop) records a tombstone of its
    owner, generation and revision, so a delayed `apply` from a released
    generation or an older revision is refused instead of re-installed.
- Leases are 1–60 s (the host uses 15 s and renews every 5 s) and are enforced
  inside the extension, independently of the daemon: a dead or hung daemon
  leaves an app offline for at most one lease. Time comes from `CLOCK_MONOTONIC`
  (`SystemMonotonicClock`), which keeps counting while the Mac sleeps and never
  follows wall-clock changes. Expiry is evaluated lazily on every flow and
  command, so a lease that elapsed during sleep is already over at the first
  flow after wake; no timer has to fire. `stopFilter` and a provider restart end
  every rule.
- `AppFlowPolicy` decides each new flow when it arrives. While a rule is active
  it attributes the flow with `SimulatorFlowResolver`, limited to the simulators
  active rules name, and drops it only when the flow is `attributed` to that
  simulator and the app's code-signing identifier equals the rule's bundle
  identifier. Delegated flows match through the app token. Unattributed,
  conflicting and failed lookups are allowed (fail open). Code identity is
  cached per audit token (one process generation, at most 512 entries), and the
  ancestor walk stays bounded by `SimulatorFlowResolver.maximumAncestorDepth`.
- Attribution runs outside the store's lock, so the drop is committed against
  the rule ticket (owner, generation, revision) it was computed for. If the
  rule was reset, replaced or expired meanwhile, the flow is re-checked once
  against the current rule and otherwise allowed.
- Only **new** socket flows are dropped. Established connections were allowed
  before the rule existed and the provider has no data callbacks, so they keep
  working until they close; the app sees the outage on its next connection.
- A sibling simulator running the same bundle, a native Mac app with the same
  identifier, and the daemon's own control connections are never selected,
  because they are not attributed to the rule's simulator and app.

## Build and signing

Run from the repository root:

```bash
bun run bootstrap:worktree
swift test --package-path ios/network-filter -Xswiftc -warnings-as-errors
bash scripts/ios/build-network-filter-probe.sh unsigned
```

The unsigned `.app` is written to a unique directory under `scratch/`; it is
only a build artifact and cannot establish native provider behavior.

For an installable build, register these identifiers in the Apple Developer
account and create Developer ID provisioning profiles allowing the listed
entitlements:

| Component | Identifier | Required capabilities |
| --- | --- | --- |
| Containing app | `dev.jasonpearson.automobile.networkfilter` | Network Extension, System Extension installation, App Groups |
| Provider | `dev.jasonpearson.automobile.networkfilter.provider` | Network Extension, App Groups |
| Shared app group | `<TEAMID>.dev.jasonpearson.automobile.networkfilter` | Both components |

The distribution entitlement is `content-filter-provider-systemextension`.
Both components are sandboxed. Templates under `Packaging/` list the exact
entitlements; the build fills the team, application identifiers, and Mach service
name through PlistBuddy's structured property-list interface.

Set `MACOS_DEVELOPER_ID_SIGNING_IDENTITY`, `MACOS_DEVELOPER_ID_TEAM_ID`,
`MACOS_PROBE_CONTROLLER_PROFILE`, and `MACOS_PROBE_PROVIDER_PROFILE`, plus the
existing `APPLE_NOTARY_KEY_PATH`, `APPLE_NOTARY_KEY_ID`, and
`APPLE_NOTARY_ISSUER_ID` variables. Then run:

```bash
bash scripts/ios/build-network-filter-probe.sh signed
```

The script builds both macOS slices (`arm64` and `x86_64`), combines them with
`lipo`, and asserts `lipo -archs` lists both before anything is signed, so the
artifact launches on Intel and Apple Silicon Macs alike (#6897). It follows the
existing macOS signing flags, signs the nested extension
before the app, and reuses `scripts/ci/notarize-macos-artifact.sh`. The existing
`sign-macos-products.sh` handles standalone Swift products, so provisioning and
nested system-extension bundle assembly live here. No dependencies were added:
Foundation, Security, NetworkExtension, SystemExtensions, SwiftPM, and the
existing notarization helper cover this milestone.

After placing the signed app in `/Applications`, invoke its executable:

```bash
"/Applications/AutoMobile Network Identity Probe.app/Contents/MacOS/network-filter-controller" activate
"/Applications/AutoMobile Network Identity Probe.app/Contents/MacOS/network-filter-controller" status
"/Applications/AutoMobile Network Identity Probe.app/Contents/MacOS/network-filter-controller" snapshot
```

### Controller JSON contract (version 3)

Every command prints exactly one line of JSON on stdout, then exits. The daemon
runs the installed controller as a subprocess and parses this line
(`src/features/network-filter/NetworkFilterBridge.ts`); it never talks XPC to
the provider, which only accepts peers signed by its own team. The types live in
`Sources/NetworkFilterCore/ControllerContract.swift`.

```json
{"detail":"…","snapshot":{…},"state":"ready","version":2}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | integer | `ControllerContract.version`, currently `3` (version 2 added attribution; version 3 adds the rule commands, `rule`, and the snapshot's `rules`; there is no fallback). Bump it whenever a field changes meaning or a required field is added or removed; the daemon reports any other version as `unavailable`. It is independent of the snapshot's own `version`. |
| `state` | string | `installation_required`, `approval_required`, `unavailable`, or `ready`. |
| `detail` | string | Human-readable reason or next step. |
| `snapshot` | object, optional | `status`/`snapshot` when `ready`: the provider's snapshot, with its own `version`, its `mode` (`allow_only` or `app_offline`) and the active `rules`. |
| `rule` | object, optional | `apply`/`reset`/`renew` when `ready`: the provider's definitive `outcome`, `installedRevision` and `leaseRemainingMilliseconds`. Absent whenever the outcome is unknown. |

Commands: `activate`, `status`, `snapshot` (`status` and `snapshot` are
read-only and take repeatable `--managed <device-set-path> <udid>` pairs naming
the host's booted simulators; the daemon passes them), and the rule commands
`apply|reset|renew --managed <device-set-path> <udid> --bundle-id <id> --owner
<session> --owner-generation <n> --revision <n> [--lease-ms <n>]` (`--lease-ms`
for `apply` and `renew` only). A rule command that times out or reports
`unavailable` may still have reached the provider: the daemon reconciles with
`status`, and after a lost `apply` that `status` does not show it sends a
`reset` with a newer revision so a late delivery is refused. The exit code is `0` for `ready` and the pending-approval states and
non-zero otherwise, but the JSON line is printed either way, so callers read
stdout rather than the exit code. The controller abandons its work after 8
seconds and prints `unavailable`. Byte-for-byte fixtures for each state live in
`test/fixtures/network-filter-controller/`.

For shell callers, `bash scripts/ios/build-network-filter-probe.sh activate
[app-path]` wraps the controller's `activate` and maps its JSON `state` to a
distinct exit code: `0` ready, `3` approval required in System Settings, `4`
the extension installs only after a macOS restart, `1` any other non-ready
state (#6897). The controller executable itself exits `0` for both pending
approval states, so scripts should call the wrapper rather than the executable.

AutoMobile can do the download, verification, copy and activation itself, but
only when asked (#10588). It never installs on daemon start or from
`setDeviceState`:

```bash
auto-mobile --ios-network-filter install            # download, verify, copy, activate
auto-mobile --ios-network-filter install --upgrade  # replace a differing installed copy
auto-mobile --ios-network-filter status             # read-only controller status
```

`install` checks the release zip's SHA-256 against `networkFilterSha256` in
the release checksum registry and fails closed when this version has no entry.
It then runs `codesign --verify --deep --strict` and checks the bundle
identifiers and a Developer ID team shared by the app and its provider (pin
one with `AUTOMOBILE_NETWORK_FILTER_TEAM_ID`) before it copies the app to
`/Applications`. Set `AUTOMOBILE_NETWORK_FILTER_APP_PATH` to a locally built,
signed `.app` to skip the download. The exit codes match the `activate` wrapper
above. `auto-mobile --cli doctor` reports the same states.

Initial extension and filter approval require macOS interaction, unless the Mac
is MDM-enrolled and has the committed profile from
[Managed Macs and CI runners](../../docs/using/managed-macs.md) installed (#10595). A timeout is an
uncertain installation result: inspect `status` and System Settings before
retrying. Filter configuration acknowledgement alone never reports readiness:
the controller only reports `ready` after an authenticated read-back. Because
macOS launches the provider lazily, that read-back retries startup races — an
XPC connection to a listener that has not resumed, or a reply from a provider
that has not finished starting — over a bounded ~2.2s backoff before reporting
`unavailable`. Signing and protocol rejections are never retried.
To stop collecting diagnostics, disable this probe in System Settings' Network
Extensions panel. Leave unrelated filters unchanged.

## Isolation gate and remaining acceptance work

Risk class: high for eventual blocking, because attribution errors could impair
the Mac or another session. The leased per-app offline rule is implemented and
unit-tested; none of it is natively verified until the signed run (#10263).
The issue's first milestone is: "Build the signed **allow-only identity probe**,
then prove a short leased offline/reset cycle for one controlled app while a
sibling simulator and host/control-plane probes remain healthy. Resolve this
isolation gate before broadening scope or implementing degraded profiles."

| Acceptance area | Implementation/test still required |
| --- | --- |
| Native approval and availability | Install the provisioned app; test approval, denial, restart, incompatible peer, unsigned peer, and wrong-team XPC rejection |
| Explicit simulator/app identity | Two simulators running the same fixture bundle plus a native Mac fixture; independently validate process generation and simulator provenance against both tokens |
| Delegated coverage | Foreground/background URLSession, app extension, WebKit helper, Network.framework, TCP and UDP sockets; missing attribution must remain allowed and reported |
| Leased offline/reset | Implemented and unit-tested with a fake clock (#10264). Natively: new connections of the target fail and established ones continue; lease expiry, daemon termination, extension restart and sleep/wake each end the impairment within one lease |
| Session lifecycle | Implemented with fakes (#10264): restore target carries simulator UDID, owner generation and rule revision; rollback, uncertain IPC reconciliation, release, rebind and TTL expiry. Natively unverified |
| Tool read-back | Implemented (#10264): app scope, revision, lease and partial coverage read from the provider; acknowledgement is reported, traffic behaviour is not claimed as verified |
| Latency/bandwidth | Only after isolation gate: documented directional units and app-aggregate budget; concurrent transfer measurements, UDP pause bound, unsupported effect reporting |

For each native test, retain provider snapshots and fixture observations with
the simulator IDs, process generations, request/revision, expected behavior,
observed result, and host/control-plane health. Successful diagnostic unit tests
are not native isolation evidence. Do not close #6298 on this preparation alone.

## References

- [Apple Filtering Network Traffic sample](https://developer.apple.com/documentation/networkextension/filtering-network-traffic)
- [Source app audit token](https://developer.apple.com/documentation/networkextension/nefilterflow/sourceappaudittoken)
- [Source process audit token](https://developer.apple.com/documentation/networkextension/nefilterflow/sourceprocessaudittoken)
- [Network Extension entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.networkextension)
