@testable import AutoMobileSDK
import Foundation
import XCTest

final class ContractFixtureTests: XCTestCase {
    func testWritesSdkEventFixtures() throws {
        guard let outputDirectory = ProcessInfo.processInfo.environment["AUTOMOBILE_FIXTURE_OUT_DIR"] else { return }

        let fixtures: [(String, SdkEventEnvelope)] = try [
            (
                "frame-metrics",
                SdkEventEnvelope(SdkFrameMetricsEvent(
                    timestamp: 1_700_000_000_004,
                    fps: 55,
                    frameTimeMs: 18,
                    jankFrames: 2
                ))
            ),
            (
                "navigation",
                SdkEventEnvelope(SdkNavigationEvent(
                    timestamp: 1_700_000_000_001,
                    sequenceNumber: 7,
                    sessionId: "fixture-session",
                    sessionEpoch: 2,
                    trackingGeneration: 3,
                    destination: "Details",
                    source: .deepLink,
                    arguments: ["item": "42"],
                    metadata: ["origin": "fixture"],
                    screenIdentity: "details-42",
                    sceneIdentifier: "fixture-scene",
                    transitionIdentifier: "transition-7",
                    transitionCompleted: true
                ))
            ),
            (
                "webview",
                SdkEventEnvelope(SdkWebViewEvent(
                    timestamp: 1_700_000_000_002,
                    webViewId: "fixture-webview",
                    name: "request_started",
                    url: "https://example.com/items/42",
                    frameId: "main-frame",
                    requestId: "request-42",
                    metadata: ["method": "GET"]
                ))
            ),
            (
                "storage-changed",
                SdkEventEnvelope(SdkStorageChangedEvent(
                    timestamp: 1_700_000_000_003,
                    suiteName: "fixture.defaults",
                    key: "selectedItem",
                    newValue: "42",
                    previousValue: "41",
                    valueType: "String",
                    changeType: "modify",
                    sequenceNumber: 8
                ))
            ),
        ]

        try FileManager.default.createDirectory(atPath: outputDirectory, withIntermediateDirectories: true)
        for (name, envelope) in fixtures {
            let batch = SdkEventBatch(
                bundleId: "fixture.app",
                events: [envelope],
                timestamp: 1_700_000_000_000
            )
            let data = try JSONEncoder().encode(batch)
            let destination = URL(fileURLWithPath: outputDirectory).appendingPathComponent("\(name).json")
            try data.write(to: destination)
        }
    }
}
