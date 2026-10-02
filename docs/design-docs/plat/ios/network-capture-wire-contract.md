# iOS network capture wire contract

`SdkNetworkRequestEvent` is the network wire payload for #5158. The SDK JSON-encodes it into `SdkEventEnvelope.payload` (base64), wraps envelopes in `SdkEventBatch`, and sends batches to CtrlProxy. CtrlProxy stores and returns the envelopes through `/sdk-events` without projecting the network fields. `decodeSdkEventBatches` is the production TypeScript retrieval decoder; `DefaultIosSdkEventIngestor` validates the version before recording anything as network traffic.

Capture requires host registration: install the URLProtocol on a URLSession configuration, forward URLSession delegate callbacks, or call the WebSocket/NWConnection adapters from the host's transport callbacks. Enabling capture does not instrument unregistered transports. Hosts must redact endpoint/query/metadata values before supplying them; no automatic URL or metadata sanitization is implied.

## Versions and diagnostics

The SDK's named constant is `SdkNetworkRequestEvent.currentSchemaVersion = 1`; new events always encode the integer `schemaVersion`. The initializer's default preserves existing call sites. The custom decoder used by `EventPersistence.loadPending` accepts missing versions as legacy v0 and re-encodes that version explicitly. TypeScript mirrors support in `IOS_SDK_NETWORK_SCHEMA_VERSION`.

Absent versions and explicit v0 are accepted. v1 is current. Future versions (>1), negative numbers, fractional numbers, null, and non-numeric values are rejected before network persistence and network telemetry push. Legacy `protocol` remains a fallback when `protocolName` is absent. This is version validation, not a new validator for every historical optional field.

Rejection creates a typed diagnostic with `code: "sdk_network_schema_unsupported"`, `receivedVersion`, `supportedVersion`, and `bundleId`. It is logged with `logger.warn` and recorded as a warning telemetry log (`level: 5`, `tag: "SdkNetworkWire"`, `filterName: "sdk_network_schema_unsupported"`), with the diagnostic JSON in `message`. This uses existing persisted log telemetry and the log category of the telemetry push/backfill channel, so consumers can observe it even when network capture is disabled. Ingestion never throws on a version mismatch. No network row is inserted. Version and event type are routing controls, not network data columns; no new migration is needed.

## Behavior changes

`AutoMobileNetwork.recordRequest` now redacts request and response headers with `NetworkCaptureRecorder.redactHeaders`, matching automatic capture: authorization, proxy-authorization, cookie, set-cookie, x-api-key, x-auth-token, and x-csrf-token (case-insensitive). Each matching value is replaced by `<redacted>`.

Payloads from a newer SDK schema version are rejected with one rate-limited diagnostic per device/app/version in a 10-minute window. The first diagnostic has no suppression count; the next rejected event after the window re-emits with `suppressedCount` for events suppressed since the last emission. Received versions are bounded to 32 characters, including an ellipsis when truncated. Each ingestor tracks at most 64 keys, reserving the last slot for a shared overflow key that rate-limits additional keys together.

## Field mapping

`TelemetryRecorder.recordNetworkEvent` forwards every data field below to the repository and telemetry push. `automobile:network/traffic` (including live/error/slow lists) carries summary fields; headers, bodies, and body sizes are exposed only by `automobile:network/request/{rowId}` (detail). Both use the TS names. Request resource IDs are database row IDs, distinct from SDK `requestId`. Optional null fields remain nullable; legacy rows continue to read.

| Wire key         | Swift property   | TS ingestion/output                                        | Column                | MCP surface              |
| ---------------- | ---------------- | ---------------------------------------------------------- | --------------------- | ------------------------ |
| eventType        | eventType        | network_request routing                                    | none                  | selects network category |
| schemaVersion    | schemaVersion    | version gate                                               | none                  | mismatch log diagnostic  |
| timestamp        | timestamp        | timestamp                                                  | timestamp             | traffic + request        |
| url              | url              | url                                                        | url                   | traffic + request        |
| method           | method           | method                                                     | method                | traffic + request        |
| requestId        | requestId        | requestId                                                  | request_id            | traffic + request        |
| connectionId     | connectionId     | connectionId                                               | connection_id         | traffic + request        |
| direction        | direction        | direction                                                  | direction             | traffic + request        |
| protocolName     | protocolName     | protocol (legacy protocol fallback)                        | protocol              | traffic + request        |
| metadata         | metadata         | metadata                                                   | metadata_json         | traffic + request        |
| sequenceNumber   | sequenceNumber   | sequenceNumber                                             | sequence_number       | traffic + request        |
| requestHeaders   | requestHeaders   | requestHeaders                                             | request_headers_json  | detail                   |
| requestBodySize  | requestBodySize  | requestBodySize (absent: -1)                               | request_body_size     | detail                   |
| statusCode       | statusCode       | statusCode (absent: 0)                                     | status_code           | traffic + request        |
| responseHeaders  | responseHeaders  | responseHeaders                                            | response_headers_json | detail                   |
| responseBodySize | responseBodySize | responseBodySize (absent: -1)                              | response_body_size    | detail                   |
| durationMs       | durationMs       | durationMs (fallback: finite metadata.duration_ms, then 0) | duration_ms           | traffic + request        |
| error            | error            | error                                                      | error                 | traffic + request        |
| host             | host             | host                                                       | host                  | traffic + request        |
| path             | path             | path                                                       | path                  | traffic + request        |
| requestBody      | requestBody      | requestBody                                                | request_body          | detail                   |
| responseBody     | responseBody     | responseBody                                               | response_body         | detail                   |
| contentType      | contentType      | contentType                                                | content_type          | traffic + request        |

## Redaction and bounds

The existing `NetworkCaptureRecorder.redactHeaders` covers Authorization, Proxy-Authorization, Cookie, Set-Cookie, X-API-Key, X-Auth-Token, and X-CSRF-Token case-insensitively. Adapters apply it when recording headers; the shared `AutoMobileNetwork.recordRequest` emission boundary now applies it too, so manual, task-delegate, and URLProtocol callers receive the same policy. Headers still require opt-in capture.

Recorder bodies are bounded by `maxBodyBytes` (default 32 KiB); the shared emitter applies `truncateBody` again with its configured byte bound before events enter the SDK buffer. Body capture is opt-in and disabled in release builds. TS repository reads apply the existing surrogate-safe `truncateBodyText` cap of 10,240 UTF-16 units to both traffic and request reads; original body sizes survive. TS does not introduce a new storage/body bound. SDK metadata has no size limit to mirror, so TS preserves it unchanged. These bounds do not imply body-value redaction or arbitrary metadata sanitization.

`NetworkState` notifications contain only resource URIs and trigger a fresh read; its internal debounce/filter record is not a separate payload read surface. The resource read and telemetry data paths retain the fields above.

## Serialized contract fixtures

The sole fixture source is `NetworkCaptureRecorderTests.testWritesSerializedNetworkCaptureFixtures`. Regenerate from the repository root:

```bash
cd ios/auto-mobile-sdk
AUTOMOBILE_FIXTURE_OUT_DIR=../../test/fixtures/ios-sdk-network swift test --disable-sandbox --filter NetworkCaptureRecorderTests.testWritesSerializedNetworkCaptureFixtures
```

Copy output verbatim; generation provenance is documented in `test/fixtures/ios-sdk-network/README.md`. Never hand-author SDK-encoded fixture JSON. `urlsession`, `websocket`, and `nwconnection` cover the three adapters; `urlsession-full` and `urlsession-error` add bounded bodies, response headers/content type, and an HTTP error with top-level timing. Host callbacks enrich adapter records with top-level timing/content type and observed status because the adapter itself does not currently supply them. The error fixture has every network data property non-nil. A WebSocket host supplies its observed handshake status.

`IosSdkNetworkPersistence.contract.test.ts` enumerates event batch fixtures (excluding generated `contract-keys.json`) and exercises the production batch decoder → real telemetry recorder → injected in-memory DB → repository list/detail → registered MCP traffic/request handlers and telemetry push. It compares the explicit column map with the generated Swift `CodingKeys` list, catching unmapped fields even when always nil, and a non-null union guard requires fixture examples for every property. Version test variants derive legacy/current/future payloads from real fixture JSON, without claiming those variants are SDK-encoded files. Decoder unit tests cover malformed envelopes, clock fallback, order, and poll generation cancellation.

```bash
bun test test/features/observe/ios/IosSdkNetworkPersistence.contract.test.ts
bun test test/features/observe/ios/decodeSdkEventBatches.test.ts
bash scripts/ios/api-dump.sh --check
```
