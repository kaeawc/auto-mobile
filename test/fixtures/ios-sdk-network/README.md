# iOS SDK network capture fixtures

These JSON files were emitted by `SdkEventEnvelope` and `SdkEventBatch`, the same encoding path used by `SdkEventBroadcaster` to send events to CtrlProxy. `NetworkCaptureRecorderTests.testWritesSerializedNetworkCaptureFixtures` creates the URLSession, URLSessionWebSocketTask, and NWConnection records through the SDK transport adapters, then records them through `AutoMobileNetwork`.

SDK git commit: `fad4d4d50fdd7ea7dbb04723cd67a24456b041ca`

Reproduce from the repository root:

```bash
cd ios/auto-mobile-sdk
AUTOMOBILE_FIXTURE_OUT_DIR=../../test/fixtures/ios-sdk-network swift test --disable-sandbox --filter NetworkCaptureRecorderTests.testWritesSerializedNetworkCaptureFixtures
```

The fixture JSON files are copied verbatim from that command's output. The test does nothing when `AUTOMOBILE_FIXTURE_OUT_DIR` is unset.
