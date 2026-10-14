# Simulator network filter

Backend for iOS Simulator `networkCondition` (#6298). It reports flow identity
and applies leased **offline**, latency and bandwidth rules for one explicitly
named app on one simulator (#10264, #10265), implemented and unit-tested only,
compiled unsigned, and unverified against real traffic until the signed run (#10263).
Packet loss remains unapplied.
Simulator attribution, signed installation,
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
- Version 4 Codable/XPC snapshots and rule commands, negotiating version 3 by default (version 1 and 2
  snapshots still decode).
  Both peers require an Apple-signed executable with the expected bundle
  identifier and their own signing team.
- With no active rule, every new socket flow receives `allow()` without any
  lookup. The callback copies audit tokens into a lock-protected history of at
  most 128 entries. This fast path never reads payloads, records network addresses, or
  pauses a flow.
- Snapshots use Security's audit-token lookup for both source-app and
  source-process code metadata. Complete audit tokens retain process generation;
  bundle identifiers and PIDs are not interpreted as simulator identity.
  Missing/malformed tokens and failed metadata lookup remain unattributed.
- Per-simulator attribution (#10589) runs at snapshot time for diagnostics
  and at new-flow time while a rule is active. `SimulatorFlowResolver` maps each flow's audit tokens to one
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
- Restart ends every rule and settles paused flows once with allow. There is
  no persisted impairment, control-channel bypass, or target-app instrumentation.

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
  before the rule existed, so they keep working until they close; the app sees the outage on its next connection.
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

### Controller JSON contract (versions 3 and 4)

Every command prints exactly one line of JSON on stdout, then exits. The daemon
runs the installed controller as a subprocess and parses this line
(`src/features/network-filter/NetworkFilterBridge.ts`); it never talks XPC to
the provider, which only accepts peers signed by its own team. The types live in
`Sources/NetworkFilterCore/ControllerContract.swift`.

```json
{"detail":"…","snapshot":{…},"state":"ready","version":3}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | integer | Negotiated invocation version: newest `4`, supported `[3, 4]`, default `3`. The daemon requests `4` and supports `3` for offline commands after the released controller rejects the contract flag; shaped applies require an upgrade. The provider snapshot must carry the same negotiated version. |
| `state` | string | `installation_required`, `approval_required`, `unavailable`, or `ready`. |
| `detail` | string | Human-readable reason or next step. |
| `snapshot` | object, optional | `status`/`snapshot` when `ready`: the provider's snapshot, with its own `version`, its `mode` (`allow_only` or `app_offline` in version 3; also `app_shaped` and `app_mixed` in version 4) and the visible active `rules`. |
| `rule` | object, optional | `apply`/`reset`/`renew` when `ready`: the provider's definitive `outcome`, `installedRevision` and `leaseRemainingMilliseconds`; version 4 can also carry a `shaping` resolution or an `invalid_shaping` rejection. Absent whenever the outcome is unknown. |

Every command accepts `--contract-version <n>` only immediately after its name:
`network-filter-controller <command> --contract-version <n> …`. The value must
be exactly `3` or `4`. Omitting it uses version 3, so the version-3 host works
unchanged with a controller built from this package. Explicit version 3 is
byte-compatible with the previous encoder. A missing, malformed or unsupported
value prints one version-4 `unavailable` line naming supported versions and exits 2.
The detail retains the historical wording "Invalid or repeated --contract-version"
for fixture compatibility. A later occurrence is passed unchanged to the command's
parser, as a value where expected or its usual unexpected argument error; it does
not negotiate or count as repeated negotiation. All other endings, including
argument errors, installation requirements and the 8-second timeout, carry the
negotiated version. The controller passes that version over XPC; the provider
accepts 3 and 4.

In this build, version-3 `activate` ignores trailing arguments; version-4
`activate` rejects any arguments after the negotiation pair with an `activate`
usage error. An installed version-3 controller rejects `--contract-version 4`
as an unknown flag for `status`, `snapshot`, `apply`, `reset` and `renew`, printing
its own version-3 `unavailable` line. Its `activate` instead ignores the arguments,
performs activation and answers with version-3 lines. A host that needs version 4
must check the version of every returned line and never assume the flag was honoured.

Version-3 snapshots omit shaped rules, use only `allow_only`/`app_offline`, and
append one limitation stating the omitted count and that version 3 supports only
offline rules. Version-3 XPC shaped commands return `invalid_command`.

Version-4 `apply` accepts `--delay-ms <n>`, `--down-kbps <n>`, `--up-kbps <n>`
and `--packet-loss-percent <x>`. Any one flag makes a shaped request, with omitted
values zero; no shaping flags means offline. Reset/renew, repeated flags and
non-numeric values reject these flags. Version 3 rejects them with an argument
error requiring `--contract-version 4`. Integral fields use unsigned integers;
loss accepts finite decimals. Range and applicability validation belongs to the
provider, never the controller.

The wire condition remains `"condition":"offline"` with no `shaping` sibling,
or `"condition":"shaped"` with a required `shaping` sibling. Commands carry the
unresolved `ShapingRequest`; statuses and shaped applied results carry a
`ShapingResolution` with `profile`, `applied` and `unapplied` component arrays.
Profile field names state directional milliseconds and bytes per second.
`applied` names effects accepted into configuration, not behavior verified by
traffic. Non-zero loss remains `unapplied:["packetLoss"]`: consumers must report
that fidelity gap as partial. Missing/invalid shaped siblings fail decoding.
`invalid_shaping` carries either `rejection:{"reason":"out_of_range","component":"latency"}`
(or the rejected component), or `rejection:{"reason":"nothing_to_apply","unapplied":["packetLoss"]}`
(the array is empty for an all-zero request). Rejections leave state unchanged.

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
| Latency/bandwidth | Core scheduler and provider glue implemented and unit-tested (#10265). Native isolation, concurrent transfers, byte windows, UDP pause bounds and sleep/wake remain unverified (#10263) |

For each native test, retain provider snapshots and fixture observations with
the simulator IDs, process generations, request/revision, expected behavior,
observed result, and host/control-plane health. Successful diagnostic unit tests
are not native isolation evidence. Do not close #6298 on this preparation alone.

## Shaping data path (#10265, native effects unverified)

`NetworkFilterCore` contains a Foundation-only `ShapingProfile` and `FlowShaper`.
The controller and version-4 XPC contract now carry shaping requests and
resolutions, and `NetworkRuleStore` can carry resolved profiles when constructed
with `supportsShaping: true`. The store is a `ShapingRuleSource`, tested together
with the scheduler using a fake monotonic clock. Shaped rules share offline's
ownership/generation/revision fencing, capacity, renewal, expiry and tombstones.
Identical apply redelivery refreshes the lease; a differing condition or request
at the installed revision returns `invalid_command`. Newer revisions can replace
offline with shaped configuration or vice versa. Evaluation snapshots cover both
kinds of target, while drop commit remains offline-only. A shaped rule alone
triggers attribution; only attributed new socket flows of its app are shaped,
implemented and unit-tested only, compiled unsigned, and unverified against
real traffic until the signed run (#10263).

The provider constructs its store with `supportsShaping: true`, resolves
requests in Core, and reports `invalid_shaping` when out of range or nothing is
applicable. The default Core store still refuses shaping with
`unsupported_condition`. Shaped rules are enforced on **NEW flows** of the
attributed app only, implemented and unit-tested only, compiled unsigned, and
unverified against real traffic until the signed run (#10263); established flows
are not shaped. The unsigned provider
compiles, but every data-path NetworkExtension assumption and all traffic
effects remain unverified until the signed run (#10263). Configuration
acknowledgements are not traffic evidence. The native isolation gate above still applies.

Outbound means app to remote (upload); inbound means remote to app (download).
One target is one app on one simulator (`NetworkRuleTarget`). Host requests use
added **round-trip** integral milliseconds (0...4000), integral decimal kilobits
per second (1000 bits; zero is unlimited, otherwise 8...1000000), and finite
loss percent (0...100, including fractional values).
Resolution splits delay into outbound `ceil(delay/2)` and inbound the remainder,
and converts each rate to bytes per second with `kbit/s * 125`. Profiles validate
both construction and decoding: each directional delay is 0...2000 ms, each
optional directional rate is 1000...125000000 bytes/s, and at least one effect
is required. Non-zero packet loss is always reported as unapplied; a content
filter drop cannot prove packet-loss emulation. Loss-only and all-zero requests
are rejected, and out-of-range components are named in the rejection.

All flows of a target share one reservation timeline **per direction**; upload
and download budgets are independent. For a rate-limited stream, one grant is
`min(availableBytes, clamp(rate/10, 1...1048576))` bytes (at most 100 ms of
budget). Unlimited directions do not clamp grant size. Granted datagrams are
always whole and charged in full. Directional data peek windows use that quantum, or
65536 bytes for an unlimited direction. New-flow verdicts have a single peek
value, so they use the smallest shaped directional quantum. FIFO reservation
order lets concurrent transfers share the aggregate rate without multiplying it.

For every rate-limited grant, `slotStart = max(now, nextFree)` and
`nextFree = slotStart + ceil(bytes * 1e9 / rate)`. Integer arithmetic rounds up
and uses full-width multiplication/division; unrepresentable times saturate,
and an exhausted timeline or unrepresentable delay deadline drops further work
rather than wrapping into an early release. Idle time or sleep earns no budget
credit: the first slot is available immediately and the next waits a full slot.
Backwards clock readings are clamped to the last observed reading, so time never underflows.

Latency is a **burst-start hold**, per flow and direction: first data, or data
after neither arrival nor release for at least the profile's smallest non-zero
directional delay, receives that direction's hold. Continuous chunks are not
held again. Direction activity is recorded only for granted or reserved data,
never for a dropped callback. Known limitation: the burst-start hold repeats on
every request/response exchange only when the profile delays both directions
(as `ShapingProfile.resolve` produces for any delay of 2 ms or more) or the
exchange period is at least the quiet gap; a profile that delays a single
direction holds a fast ping-pong once. New stream connections additionally hold
their new-flow verdict for one added round trip; datagram new-flow verdicts are not held.
`releaseAt = max(now + hold, slotStart)`; charging the timeline at `slotStart`
allows another flow's slot to proceed while this flow is still held.

For any window of duration T on a rate-limited target/direction, released bytes
are bounded by `rate * (T + directional delay) + (1 + D) grants`; cumulatively from rule
start the bound is `rate * T + (1 + D) grants`. For differently sized datagrams,
use the largest grant in the relevant release/reservation history as the grant
size. D counts debt releases in that window: an old paused decision settled
under a different ticket, or an unexpected data callback while already paused.
Each immediately passes one grant and advances the current timeline by its full
duration. The bound is at most one callback debt release per outstanding pause,
plus one debt release per paused data decision settled under a different ticket.
These releases are visible in `debtReleases`; when D is zero the bound has
exactly one grant of slack. Counters reset on ticket changes, so measuring D
across replacements requires accumulating the observed tickets' debt releases.

`FlowShapingCoordinator` owns one timer per pause and calls `resume` at its deadline. The
non-optional `ResumeOutcome` distinguishes `.settled(ResumeDecision)` (apply the
verdict once), `.alreadySettled` (no outstanding matching pause: settled, foreign
or unknown token), and `.notDue(resumeAtNanoseconds:)` (same-ticket pause still
pending: call again at that deadline). Resume verdicts cannot contain another
pause. For an outstanding pause that has not latched allow, resume re-reads the
rule: no rule allows and forgets the flow; a due same-ticket pause releases its
reservation; a different ticket discards the old decision and immediately
passes bytes re-clamped to the current stream quantum, charged as debt with no
new hold (or filters a paused new flow under the current profile). A due pause,
replacement or removed rule always settles; if the current timeline cannot be
created at capacity, resume settles with allow and forgets the flow.

A ticket change inherits each direction's `nextFree` from the previous target
timeline and resets counters; a direction that is no longer rate-limited ignores
its inherited budget. Replacements therefore earn no fresh first slot.
Same-ticket lease renewals preserve both budgets and counters. A timeline pruned
because its target had no rule starts fresh if that target is later admitted.
Data callbacks also re-check the rule. Once allow is returned for a tracked
flow, subsequent data decisions can only allow: an unpaused flow is forgotten
immediately, while a paused flow retains an allow latch and its token until
`resume`, `settleStale`, `flowEnded` or `removeAll` settles it with allow and
forgets it, regardless of any intervening rule installation. Reset, replacement
or a latched allow can settle before the deadline. Rule-source lock order is
**coordinator lock → shaper lock → rule source**; the source must never call back into the shaper.

An unexpected callback while paused never adds a second pause: at most one
positive callback passes one grant as debt and leaves the original pause valid,
across both directions and intervening ticket changes. A second positive
callback drops, counts an over-budget drop, and forgets the flow; its old token
then returns `.alreadySettled`. Empty/negative available-byte callbacks pass
zero with the directional peek window and no charge, and do not consume this
debt allowance; callbacks while paused are still counted. An allow latch takes
precedence over all of these data decisions. No payload data is buffered.
Each flow retains at most one reservation and one timer token. Stream waits are
limited to 30 seconds; datagram waits to 8 seconds, below Apple's ten-second UDP
pause limit. A longer required pause drops without reserving or charging bytes.
A positive rate-limited datagram data callback also drops, uncharged and counted
as over-budget, when its own `ceil(bytes * 1e9 / rate)` exceeds 8 seconds, even on an idle timeline
or during a pause. Exactly 8 seconds of budget is permitted.
The 256-flow cap and stream quantum bound normal stream waits below 30 seconds
only when no datagram flow shares that target's direction; a wait above the
limit drops the flow. Every data drop forgets the flow and invalidates its
outstanding pause, with no activity or charge from the rejected callback;
charges from previously accepted grants remain on the shared timeline.

There are at most 256 tracked flows and 64 timelines. At flow capacity, admission
evicts the least recently active unpaused flow idle for at least 60 seconds
(UUID order breaks ties); otherwise it drops and counts a refusal. At timeline
capacity, it prunes targets without a rule before refusing a new target. Data
for an unknown/ended/evicted flow allows and increments the separate
`untrackedDataCallbacks` accessor. Refused-only targets have a bounded 64-entry
FIFO diagnostic history, migrated into their timeline if subsequently admitted.

`settleStale` allows paused flows with no current rule or with an allow latch,
and prunes timelines of targets without a rule. `flowEnded` and `removeAll` also
settle outstanding pauses with allow; all return settlements exactly once, and stale sweeps and provider-stop results
are sorted by ascending pause ID. A resume of an already settled pause returns
`.alreadySettled`. Stop clears flows, timelines and counters, but pause IDs and the clock clamp persist
so old tokens cannot match new work. Codable status is sorted by device set,
simulator UDID and bundle ID, and reports the current ticket, tracked/paused
flows, directional bytes and held bursts, over-budget drops, refusals, paused
callbacks and debt releases.

### Adapter lifecycle and diagnostics

The thread-safe Core adapter owns no payloads, at most 256 pending handlers,
256 filter-direction records and 256 first-completion records (oldest forgotten
first). A filtered flow ends after all requested directions complete; a pause
before its first filter verdict assumes both directions. The filter-direction
record of an idle-evicted flow leaves only through the 256-entry FIFO cap or stop.

Claiming a handler under the coordinator lock gives exactly-once delivery for
timers, rule reset/expiry/replacement, completion, drop and stop. Handlers and
scheduler calls run outside all coordinator locks. Every delivery is queued at
`max(now, pausedAt + 10 ms)`, never on the callback's stack. Rules changed hooks
re-check every pause immediately: same-ticket early resumes stay pending; new
tickets settle using the current profile, with data release charged as debt.
A one-second tick sweeps expired rules and resumes due tokens even when their
individual timer was lost or late. One tick remains outstanding until it fires;
it stops repeating when nothing is pending and restarts on the next pause.
Stop invalidates the tick and all tokens; stale scheduled work does nothing.

`DispatchPauseScheduler` uses a private serial queue and arms every work item on
both wall and uptime deadlines: sleep is covered by the wall deadline, a clock
step by the uptime deadline, and the tick remains the backstop for a lost wake-up.
The first wake at or after the monotonic deadline claims the work exactly once;
an early wake re-arms only its own time base and the losing wake does nothing.
This also prevents early wakes from bypassing minimum-age handler delivery. Backwards
readings are clamped, and restart drops rules rather than restoring impairment.

Version-4 snapshots optionally expose top-level `shapingActivity`: `flows`
(the shaper's per-ticket counters), `untrackedDataCallbacks`, `pendingPauses`,
`filteredFlows`, `completionRecords`, `tickOutstanding`, `orphanedPauses` and
`unexpectedSecondPause`. Version 3 never includes this field. Flow-history
attribution and its reasons report coverage gaps; unattributed flows remain allowed.

### UNVERIFIED NetworkExtension assumptions

The call sites compile unsigned. These assumptions require the signed run (#10263):

1. A paused flow receives no further data callbacks in either direction until
   resumed. If it does, the scheduler passes one debt grant, then drops the flow.
2. `passBytes` smaller than the offered count is honoured; the next callback offers
   the remaining bytes up to `peekBytes`. Datagram flows accept a whole datagram's
   byte count.
3. `resumeFlow(_:with:)` accepts pass/peek data verdicts for data pauses and
   filter-data, allow or drop verdicts for new-flow pauses. Resumes are attempted
   at least 10 ms after the pause verdict is returned.
4. UDP flows survive pauses up to 8 s (Apple documents 10 s).
5. Wall-deadline wake-ups fire promptly after sleep; the one-second tick bounds
   the damage if they do not.
6. `NEFilterFlow.identifier` is stable for a flow's lifetime and unique among live flows.
7. Stream data-complete callbacks arrive for both directions; otherwise 60 s idle
   eviction frees the slot on a later admission.
8. Returning `allow()` from one direction's data-complete callback does not stop
   filtering the other direction. If false, the other direction is simply unshaped;
   the pending pause is still settled once.
9. Returning `allow()` from a data callback on a paused flow does not itself resume
   or unfilter it before `resumeFlow`. If false, the rest of the flow is simply
   unshaped; the pending pause is still settled once.

## References

- [Apple Filtering Network Traffic sample](https://developer.apple.com/documentation/networkextension/filtering-network-traffic)
- [Source app audit token](https://developer.apple.com/documentation/networkextension/nefilterflow/sourceappaudittoken)
- [Source process audit token](https://developer.apple.com/documentation/networkextension/nefilterflow/sourceprocessaudittoken)
- [Network Extension entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.networkextension)
