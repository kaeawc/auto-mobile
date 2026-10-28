# iOS SDK contract suite

The contract suite (#5164) drives SDK capabilities inside a real host app on a simulator and
follows each result through CtrlProxy, the daemon's iOS client and the MCP surface. Layer-local
tests prove each side encodes and decodes its own fixtures; this suite proves the layers agree
with each other on the shipped artifacts. It is the conformance backstop for #5157 and grows one
slice per capability. The network slice exists today; observation, capability-matrix, storage,
WKWebView and fault slices are added by #5159, #5160, #5161, #5162 and #5163.

## Parts

| Part         | Location                                      | Role                                                                                 |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| Fixture host | `ios/Playground/Sources/SdkContract/`         | Runs one scenario per launch, against loopback listeners only, and writes a manifest |
| Harness      | `scripts/ios/sdk-contract/run.ts`             | Launches Playground, reads the manifest and the MCP resources, judges each case      |
| Wrapper      | `scripts/ios/sdk-contract-integration.sh`     | Builds Playground (Debug) for the booted simulator and runs the harness              |
| CI           | `XCTestRunner Simulator Tests` (both systems) | `Run iOS SDK contract suite`, after the navigation graph step                        |

Playground does nothing unless launched with `PLAYGROUND_SDK_CONTRACT=<scenario>` and
`PLAYGROUND_SDK_CONTRACT_RUN_ID=<id>` (passed as `SIMCTL_CHILD_*`). The run id is limited to
ASCII letters, digits and hyphens because it becomes a file name and a URL path segment.

## Manifest

Playground always writes `Documents/sdk-contract/<runId>.json`, even when the scenario fails, so
a missing manifest means the host never ran. It records:

- `status`: `complete` when the scenario ran to the end, `failed` with `failure` otherwise;
- one expected record per case, with the values the scenario gave the SDK adapter (absent fields
  are not asserted);
- `events`: this run's envelopes exactly as the SDK encoded them. Playground observes the batch
  notification `SdkEventBroadcaster` posts just before delivery to CtrlProxy, so the bytes are
  captured whether or not delivery succeeds;
- `undecodableBatches`: batches the SDK posted that its public `SdkEventBatch` type cannot decode.

`scripts/ios/sdk-contract/manifest.ts` is the TypeScript schema; a newer `schemaVersion` is
rejected rather than read.

## Boundary attribution

For each case the harness compares five observations and reports the first layer that disagrees.
Later layers are not judged, because their input is already wrong.

| Observation                                                   | Disagreement reported as |
| ------------------------------------------------------------- | ------------------------ |
| Manifest missing, unparsable or `failed`                      | `fixture-host`           |
| SDK payload missing, differs from the adapter input, or leaks | `sdk-serialization`      |
| Production replay of the SDK bytes drops or changes the row   | `ios-client`             |
| Replayed row correct, replayed request resource wrong         | `mcp-surface`            |
| Live resource missing, CtrlProxy still queues the event       | `ios-client`             |
| Live resource missing, CtrlProxy queue empty                  | `sdk-endpoint`           |
| Live resource differs from the replay of the same bytes       | `ctrlproxy-command`      |

The replay (`referencePipeline.ts`) runs the SDK's captured batch through the same decoder,
ingestor, repository and `automobile:network/request/{id}` handler the daemon uses, against a
private in-memory database. Because the live path differs from the replay only by CtrlProxy and
the daemon's polling, a live/replay difference isolates the transport. The CtrlProxy queue probe
(`GET /sdk-events`) drains the queue, so it runs only after the live wait has expired.

## Network slice

The scenario registers the SDK adapters the way a host does (no URLProtocol, no swizzling) and
exchanges one message per transport with Playground's loopback listeners: a URLSession `GET`, a
URLSessionWebSocketTask text echo (one sent and one received frame) and an NWConnection raw HTTP
exchange. URLs carry `/contract/<runId>/`, which is how the manifest and the traffic query pick
out this run. The URLSession request carries `Authorization: Bearer contract-secret`; the header
must arrive as `<redacted>` and the secret must not appear in any SDK payload.

The harness enables capture with the `network` tool before launch, because the daemon drops
network rows while capture is off, and reads `automobile:network/traffic` filtered by device,
host and launch time until every SDK request id appears.

## Failure modes

- No CtrlProxy reachable from the app: the SDK keeps events pending and the cases report
  `sdk-endpoint`.
- The session's CtrlProxy client is not draining: events stay queued and report `ios-client`.
- The scenario times out after 30 s or a listener fails: `fixture-host` with the reason.
