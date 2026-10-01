# iOS SDK contract fixtures

`navigation.json`, `webview.json`, and `storage-changed.json` are byte-for-byte output from `ContractFixtureTests.testWritesSdkEventFixtures` in `ios/auto-mobile-sdk/Tests/AutoMobileSDKTests/ContractFixtureTests.swift`. The test constructs SDK event types and uses the production `SdkEventEnvelope` and `SdkEventBatch` encoders, which are also used by `SdkEventBroadcaster`. Capture started from SDK source at `2bf7c7f52508967d82edaf9ca4021764635f1bce` with this test added.

Reproduce from `ios/auto-mobile-sdk` on a host Mac:

```sh
AUTOMOBILE_FIXTURE_OUT_DIR=../../test/fixtures/ios-contract swift test --disable-sandbox --filter ContractFixtureTests.testWritesSdkEventFixtures
```

The test skips file output when `AUTOMOBILE_FIXTURE_OUT_DIR` is unset. The TypeScript tests pass each batch to `IOSCtrlProxyClient`'s SDK batch decoder, assert all encoded payload fields, and then assert the existing iOS ingestor's mapped telemetry fields using injected fakes. This first slice does not drive a live CtrlProxy, MCP endpoint, simulator, or host app. The ingestor does not currently persist navigation session/order/identity fields or the storage sequence number; the client decoder preserves them and the tests pin them there.
