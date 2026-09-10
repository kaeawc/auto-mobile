# Simulator network identity probe

Preparatory work for #6298. This is an **allow-only diagnostic**, not an
implementation of `networkCondition`. It cannot apply offline, latency, or
bandwidth rules. Simulator attribution, signed installation, authenticated XPC
at runtime, and network isolation still require native integration evidence.

## Current implementation

- macOS 13+ Swift containing-app/controller and `NEFilterDataProvider` system
  extension. macOS 13 is required for `sourceProcessAuditToken` and Foundation's
  per-connection code signing requirement API.
- Supported SystemExtensions activation and NEFilterManager configuration.
  Controller output distinguishes `installation_required`, `approval_required`,
  `unavailable`, and `ready`. Ready means the allow-only provider replied over
  authenticated XPC, not that any traffic behavior has been verified.
- Version 1 read-only Codable/XPC snapshots. Both peers require an Apple-signed
  executable with the expected bundle identifier and their own signing team.
- New socket flows always receive `allow()`. The callback copies audit tokens
  into a lock-protected history of at most 128 entries. It never resolves process
  metadata, reads payloads, records network addresses, pauses, or drops a flow.
- Snapshots use Security's audit-token lookup for both source-app and
  source-process code metadata. Complete audit tokens retain process generation;
  bundle identifiers and PIDs are not interpreted as simulator identity.
  Missing/malformed tokens and failed metadata lookup remain unattributed.
- Restart discards the diagnostic history. There is no persisted impairment,
  delayed flow verdict, control-channel bypass, or target-app instrumentation.

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

The script follows the existing macOS signing flags, signs the nested extension
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

Initial extension and filter approval require macOS interaction. A timeout is an
uncertain installation result: inspect `status` and System Settings before
retrying. Filter configuration acknowledgement alone never reports readiness.
To stop collecting diagnostics, disable this probe in System Settings' Network
Extensions panel. Leave unrelated filters unchanged.

## Isolation gate and remaining acceptance work

Risk class: high for eventual blocking, because attribution errors could impair
the Mac or another session. Only the allow-only preparation is implemented.
The issue's first milestone is: "Build the signed **allow-only identity probe**,
then prove a short leased offline/reset cycle for one controlled app while a
sibling simulator and host/control-plane probes remain healthy. Resolve this
isolation gate before broadening scope or implementing degraded profiles."

| Acceptance area | Implementation/test still required |
| --- | --- |
| Native approval and availability | Install the provisioned app; test approval, denial, restart, incompatible peer, unsigned peer, and wrong-team XPC rejection |
| Explicit simulator/app identity | Two simulators running the same fixture bundle plus a native Mac fixture; independently validate process generation and simulator provenance against both tokens |
| Delegated coverage | Foreground/background URLSession, app extension, WebKit helper, Network.framework, TCP and UDP sockets; missing attribution must remain allowed and reported |
| Leased offline/reset | After identity proof, add extension-owned monotonic lease, owner generation and revision; test new and established connections, bounded scheduling, expiry, sleep/wake and restart |
| Session lifecycle | Reuse `runSessionNetworkMutation` and `trackSessionSetup`; immutable iOS restore target; prove rollback, uncertain IPC reconciliation, release/rebind races, and quarantine |
| Tool read-back | Explicit target/scope contract and actual provider configuration; physical iOS unsupported, partial coverage reported, acknowledgement distinct from traffic verification |
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
