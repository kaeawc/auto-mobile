# iOS SDK contract suite

The contract suite drives SDK capabilities inside a real host app on a simulator and follows each
result through CtrlProxy, the daemon's iOS client and the MCP surface. Layer-local tests prove each
side encodes and decodes its own fixtures; this suite proves the layers agree with each other on the
shipped artifacts. Each SDK capability is covered by one slice, described in the sections below.

## Parts

| Part         | Location                                      | Role                                                                                 |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| Fixture host | `ios/Playground/Sources/SdkContract/`         | Runs one scenario per launch, against loopback listeners only, and writes a manifest |
| Harness      | `scripts/ios/sdk-contract/run.ts`             | Launches Playground per scenario, reads the manifest and MCP resources, judges cases |
| Wrapper      | `scripts/ios/sdk-contract-integration.sh`     | Builds Playground (Debug) for the booted simulator and runs the harness              |
| CI           | `XCTestRunner Simulator Tests` (both systems) | `Run iOS SDK contract suite`, after the navigation graph step                        |

Playground does nothing unless launched with `PLAYGROUND_SDK_CONTRACT=<scenario>` and
`PLAYGROUND_SDK_CONTRACT_RUN_ID=<id>` (passed as `SIMCTL_CHILD_*`). The run id is limited to
ASCII letters, digits and hyphens because it becomes a file name and a URL path segment. The
harness runs the `network`, `capabilities`, `faults`, `observe`, `storage-default` and `storage`
scenarios in that order, each in a fresh Playground process, because host registration cannot be
undone inside a process.

## Manifest

Playground always writes `Documents/sdk-contract/<runId>.json`, even when the scenario fails, so
a missing manifest means the host never ran. It records:

- `status`: `complete` when the scenario ran to the end, `failed` with `failure` otherwise;
- one expected record per case, with the values the scenario gave the SDK adapter (absent fields
  are not asserted);
- `events`: this run's envelopes exactly as the SDK encoded them. Playground observes the batch
  notification `SdkEventBroadcaster` posts just before delivery to CtrlProxy, so the bytes are
  captured whether or not delivery succeeds;
- `undecodableBatches`: batches the SDK posted that its public `SdkEventBatch` type cannot decode;
- `faults`: for the fault scenario, what the client saw per case (URL, connection and request id,
  elapsed time, and the error as `<domain>:<code>` or `posix:<code>`);
- `capabilities`: for the capability scenario, the transport descriptors before and after
  registration;
- `observation`: for the observation scenario, how many captures the contract bridge served and
  every action its executor ran;
- `storage`: for the storage scenarios, the storage registration the host applied.

`scripts/ios/sdk-contract/manifest.ts` is the TypeScript schema; a newer `schemaVersion` is
rejected rather than read.

## Boundary attribution

For each case the harness compares five observations and reports the first layer that disagrees.
Later layers are not judged, because their input is already wrong.

| Observation                                                   | Disagreement reported as |
| ------------------------------------------------------------- | ------------------------ |
| Manifest missing, unparsable or `failed`                      | `fixture-host`           |
| CtrlProxy did not deliver the fault rules to the SDK          | `ctrlproxy-command`      |
| Capability state or client-side fault outcome is wrong        | `sdk-adapter`            |
| SDK payload missing, differs from the adapter input, or leaks | `sdk-serialization`      |
| Production replay of the SDK bytes drops or changes the row   | `ios-client`             |
| Replayed row correct, replayed request resource wrong         | `mcp-surface`            |
| The host capability parser misreads an SDK descriptor         | `ios-client`             |
| Live resource missing, CtrlProxy still queues the event       | `ios-client`             |
| Live resource missing, CtrlProxy queue empty                  | `sdk-endpoint`           |
| Live resource differs from the replay of the same bytes       | `ctrlproxy-command`      |

The replay (`referencePipeline.ts`) runs the SDK's captured batch through the same decoder,
ingestor, repository and `automobile:network/request/{id}` handler the daemon uses, against a
private in-memory database. Because the live path differs from the replay only by CtrlProxy and
the daemon's polling, a live/replay difference isolates the transport. The CtrlProxy queue probe
(`GET /sdk-events`) drains the queue, so it runs only after the live wait has expired.

Records are joined across the payload, the replay and the live resource by SDK request id.
`URLProtocol` records carry none, so they are joined by method and URL instead; the run's unique
`/contract/<runId>/<case>` path keeps that key unique.

## Network slice

The scenario registers each transport with the host registration API (no swizzling) and exchanges
one message per transport with Playground's loopback listeners: a `GET` on a registered default
URLSession, which the SDK's `URLProtocol` records, a URLSessionWebSocketTask text echo (one sent and
one received frame) and an NWConnection raw HTTP exchange. URLs carry `/contract/<runId>/`, which
is how the manifest and the traffic query pick out this run. The URLSession request carries
`Authorization: Bearer contract-secret`; the header must arrive as `<redacted>` and the secret
must not appear in any SDK payload.

The harness enables capture with the `network` tool before launch, because the daemon drops
network rows while capture is off, and reads `automobile:network/traffic` filtered by device,
host and launch time until every expected record appears.

## Capability slice

Playground reads `AutoMobileNetwork.transportCapabilities()` with capture on, registers a default
URLSession, a WebSocket and an NWConnection, and reads it again. `capabilitySlice.ts` holds the
expected matrix: before registration every family is `DISABLED` with reason `HOST_OPT_IN` and the
`other` family is `UNSUPPORTED` with `NO_ADAPTER`; afterwards the three registered families are
`SUPPORTED` and `ENFORCED` with their fault actions, and the unregistered background family is still
`HOST_OPT_IN`. Each descriptor is also read back through the host's shared capability parser, which
must keep its id, state and reason. These descriptors are not served over CtrlProxy, so the slice
has no live boundary.

## Fault slice

`faultSlice.ts` owns the rules and the expected outcomes. After launch, the harness sends one
one-shot delay rule (400 ms) and one fail rule per transport with CtrlProxy's
`set_network_fault_rules` command over CtrlProxy's WebSocket, retrying while CtrlProxy reports no
SDK server; the daemon has no MCP tool that sends iOS fault rules. Once CtrlProxy confirms
delivery, the harness writes `<runId>.rules-ready` beside the manifest, which Playground waits for
before running any case. Each case runs through the transport the registration API returns:

| Case                    | Client must see                                       | SDK record                                 |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------ |
| URLSession delay        | success after the delay (a synthetic 200)             | error `fault:<id>:latency`                 |
| URLSession fail         | `NSURLErrorDomain:-1001` (rule `errorType: timeout`)  | error `fault:<id>:error`                   |
| URLSession expired      | the loopback server's 200; the one-shot rule is spent | no error                                   |
| WebSocket delay/fail    | success after the delay / `NSURLErrorDomain:-1005`    | `SEND` record with `fault_*` metadata      |
| NWConnection delay/fail | ready after the delay / `posix:54` (`reset`)          | the host's request with `fault_*` metadata |

The client outcome is judged first (`sdk-adapter`), then each record crosses the same boundaries as
the network slice.

## Observation slice

Playground registers a contract `AutoMobileObservationBridge` that declares `tap`, `insertText`
and `clearText` and publishes synthetic nodes: `contract-save` (counts taps into
`contract-tap-count`), `contract-email` (always focused, so `sendKeys` needs no XCTest focus tap),
`contract-arm-stale` and `contract-hold` (placed over the status bar). The harness runs these steps
with the MCP tools, in order, then writes `<runId>.actions-done`; Playground waits up to 180 s for
it before writing the manifest with the host's action log.

| Step                     | Tool result must show                                  | Host log must show             |
| ------------------------ | ------------------------------------------------------ | ------------------------------ |
| `observe`                | `backend: sdk` and the bridge nodes                    | (not judged)                   |
| `tap`                    | `backend: sdk`                                         | one `tap` on `contract-save`   |
| `send-keys` (replace)    | the command's `backend: sdk`                           | `insertText` of the typed text |
| `unsupported-long-press` | `backend: xctest`, `fallbackReason: unsupported`       | no `longPress`                 |
| `arm-stale`              | `backend: sdk`                                         | `tap` on `contract-arm-stale`  |
| `stale-tap`              | a failure with the bridge's `stale_observation` reason | no second `contract-save` tap  |

Once the trap is armed, the host replaces every capture with a new one as soon as the bridge has
committed it: it probes with an action naming an element no snapshot has, which the bridge rejects
before the executor (`unknown_element` once the capture is current, `stale_observation` before),
then recaptures. The observation an action was resolved against is therefore stale when the action
arrives. The host log is the ground truth: a tap it
ran that the tool misreported is `mcp-surface`, an SDK tap the tool reported that the host never ran
is `ctrlproxy-command`, an unanswered bridge is `sdk-endpoint`, an undeclared action reaching the
bridge is `sdk-adapter`, and a node that was not routed, or a stale target that did not fail
closed, is `ios-client`.

## Storage slice

`storage-default` applies the default storage configuration (nothing registered, Keychain deletion
off). `storage` registers an uncoordinated and a host-coordinated app-group suite, an app-private
and an app-group Core Data store, and Keychain deletion for one exact item, and writes a secret into
the first suite. With the app running, the harness reads
`automobile:devices/{udid}/storage/capabilities?appId=<Playground>` and compares the Keychain
capability and the `key_value` and `databases` store states with the registration
(`storageSlice.ts`). After `storage`, it terminates Playground and reads the resource again: the
Keychain capability must be `unknown` with `BRIDGE_UNAVAILABLE` and no store state may remain. A
reachable SDK reporting the wrong state is `sdk-adapter`; `BRIDGE_UNAVAILABLE` while the app runs is
`sdk-endpoint`; `SDK_TOO_OLD` is `sdk-serialization`; the secret anywhere in the resource is
`mcp-surface`.

## Failure modes

- No CtrlProxy reachable from the app: the SDK keeps events pending and the cases report
  `sdk-endpoint`.
- The session's CtrlProxy client is not draining: events stay queued and report `ios-client`.
- The scenario times out after 30 s, a case fails or a listener fails: `fixture-host` with the
  case name, the error domain and code, and the loopback server's event log (accepted, request
  path, response sent, early close).
- CtrlProxy never confirms the fault rules: `ctrlproxy-command`, and the harness skips the fault
  cases. Playground stops waiting for `<runId>.rules-ready` after 60 s.
- The harness never writes `<runId>.actions-done`: Playground fails the observation scenario after
  180 s, reported as `fixture-host`.
