@testable import AutoMobileSDK
import Foundation
import os
import XCTest

final class AutoMobileSDKConcurrencyTests: XCTestCase {
    private let bundleId = "snapshot.sdk"

    private func configuration(processors: [any EventProcessing] = []) -> AutoMobileConfiguration {
        AutoMobileConfiguration(
            eventProcessors: processors,
            enableCrashReporting: false,
            enableNetworkCapture: false,
            enableHangDetection: false
        )
    }

    private func makeSDK() -> AutoMobileSDK {
        AutoMobileSDK.makeTestInstance(
            executor: FakeMainThreadExecutor(),
            persistence: FakeEventPersistence(),
            timerFactory: { FakeTimer() }
        )
    }

    private func observeEvents(_ events: OSAllocatedUnfairLock<[SdkEventEnvelope]>) -> NSObjectProtocol {
        let bundleId = bundleId
        return NotificationCenter.default.addObserver(
            forName: SdkEventBroadcaster.eventBatchNotification, object: nil, queue: nil
        ) { notification in
            guard let data = notification.userInfo?[SdkEventBroadcaster.eventBatchUserInfoKey] as? Data,
                  let batch = try? JSONDecoder().decode(SdkEventBatch.self, from: data),
                  batch.bundleId == bundleId
            else { return }
            events.withLock { $0.append(contentsOf: batch.events) }
        }
    }

    func testNavigationAddAndFlushUseSameBufferAcrossProcessorRestart() throws {
        let broadcaster = SdkEventBroadcaster.shared
        let previousURL = broadcaster.ctrlProxyUrl
        broadcaster.ctrlProxyUrl = nil
        defer { broadcaster.ctrlProxyUrl = previousURL }
        let sdk = makeSDK()
        defer { sdk.shutdown() }
        let events = OSAllocatedUnfairLock(initialState: [SdkEventEnvelope]())
        let observer = observeEvents(events)
        defer { NotificationCenter.default.removeObserver(observer) }
        let replacementConfiguration = configuration()
        let bundleId = bundleId
        let processor = FakeEventProcessor { event in
            guard event is SdkNavigationEvent else { return event }
            // The processor runs inside add(), before the old buffer appends.
            // Restart here so shutdown cannot flush this navigation for us.
            sdk.shutdown()
            sdk.initialize(bundleId: bundleId, configuration: replacementConfiguration)
            sdk.recordWebViewEvent(SdkWebViewEvent(webViewId: "replacement", name: "pending"))
            return event
        }
        sdk.initialize(bundleId: bundleId, configuration: configuration(processors: [processor]))
        let originalBuffer = try XCTUnwrap(sdk.getEventBuffer())

        sdk.notifyNavigationEvent(NavigationEvent(destination: "original", source: .custom))

        let replacementBuffer = try XCTUnwrap(sdk.getEventBuffer())
        XCTAssertFalse(originalBuffer === replacementBuffer)
        XCTAssertEqual(events.withLock { $0.filter { $0.eventType == .navigation }.count }, 1)
        XCTAssertEqual(
            events.withLock { $0.filter { $0.eventType == .webView }.count },
            0,
            "navigation must not flush the replacement buffer"
        )
        originalBuffer.flush()
        XCTAssertEqual(
            events.withLock { $0.filter { $0.eventType == .navigation }.count },
            1,
            "the original buffer must already have been flushed"
        )
        replacementBuffer.flush()
        XCTAssertEqual(events.withLock { $0.filter { $0.eventType == .webView }.count }, 1)
    }

    func testNavigationSnapshotSurvivesListenerRestart() throws {
        let broadcaster = SdkEventBroadcaster.shared
        let previousURL = broadcaster.ctrlProxyUrl
        broadcaster.ctrlProxyUrl = nil
        defer { broadcaster.ctrlProxyUrl = previousURL }
        let sdk = makeSDK()
        defer { sdk.shutdown() }
        let events = OSAllocatedUnfairLock(initialState: [SdkEventEnvelope]())
        let observer = observeEvents(events)
        defer { NotificationCenter.default.removeObserver(observer) }
        let originalAdds = OSAllocatedUnfairLock(initialState: 0)
        let processor = FakeEventProcessor { event in
            if event is SdkNavigationEvent { originalAdds.withLock { $0 += 1 } }
            return event
        }
        sdk.initialize(bundleId: bundleId, configuration: configuration(processors: [processor]))
        let originalBuffer = try XCTUnwrap(sdk.getEventBuffer())
        let replacementConfiguration = configuration()
        let bundleId = bundleId
        sdk.addNavigationListener { _ in
            sdk.shutdown()
            sdk.initialize(bundleId: bundleId, configuration: replacementConfiguration)
        }

        sdk.notifyNavigationEvent(NavigationEvent(destination: "original", source: .custom))

        XCTAssertFalse(originalBuffer === sdk.getEventBuffer())
        XCTAssertEqual(sdk.listenerCount, 0, "shutdown removes listeners after the delivery snapshot")
        XCTAssertEqual(originalAdds.withLock { $0 }, 1, "add must use the buffer captured before listeners ran")
        let captured = events.withLock { $0 }
        let navigationEnvelope = try XCTUnwrap(captured.first { $0.eventType == .navigation })
        let navigation = try JSONDecoder().decode(SdkNavigationEvent.self, from: navigationEnvelope.payload)
        let lifecycleEnvelopes = captured.filter { $0.eventType == .lifecycle }
        let sessions = try lifecycleEnvelopes.map { try JSONDecoder().decode(SdkLifecycleEvent.self, from: $0.payload) }
        XCTAssertEqual(sessions.count, 2)
        XCTAssertEqual(navigation.sessionId, sessions.first?.sessionId)
        XCTAssertEqual(navigation.sessionEpoch, sessions.first?.sessionEpoch)
        XCTAssertNotEqual(navigation.sessionId, sessions.last?.sessionId)
        XCTAssertEqual(navigation.sequenceNumber, 1)
    }

    func testInitializedEventsFlushAndShutdownEntryPointsDoNotBuffer() throws {
        let broadcaster = SdkEventBroadcaster.shared
        let previousURL = broadcaster.ctrlProxyUrl
        broadcaster.ctrlProxyUrl = nil
        defer { broadcaster.ctrlProxyUrl = previousURL }
        let sdk = makeSDK()
        defer { sdk.shutdown() }
        let events = OSAllocatedUnfairLock(initialState: [SdkEventEnvelope]())
        let observer = observeEvents(events)
        defer { NotificationCenter.default.removeObserver(observer) }
        sdk.initialize(bundleId: bundleId, configuration: configuration())
        let buffer = try XCTUnwrap(sdk.getEventBuffer())

        sdk.recordWebViewEvent(SdkWebViewEvent(webViewId: "initialized", name: "pending"))
        XCTAssertEqual(events.withLock { $0.filter { $0.eventType == .webView }.count }, 0)
        sdk.notifyNavigationEvent(NavigationEvent(destination: "initialized", source: .custom))
        XCTAssertEqual(events.withLock { $0.filter { $0.eventType == .navigation }.count }, 1)
        XCTAssertEqual(events.withLock { $0.filter { $0.eventType == .webView }.count }, 1)

        sdk.shutdown()
        let countAfterShutdown = events.withLock { $0.count }
        sdk.notifyNavigationEvent(NavigationEvent(destination: "shutdown", source: .custom))
        sdk.recordWebViewEvent(SdkWebViewEvent(webViewId: "shutdown", name: "ignored"))
        XCTAssertNil(sdk.currentSessionId())
        XCTAssertNil(sdk.getEventBuffer())
        buffer.flush()
        XCTAssertEqual(events.withLock { $0.count }, countAfterShutdown)
    }

    func testEntryPointsRaceWithSerialLifecycleRestarts() {
        let broadcaster = SdkEventBroadcaster.shared
        let previousURL = broadcaster.ctrlProxyUrl
        broadcaster.ctrlProxyUrl = nil
        defer { broadcaster.ctrlProxyUrl = previousURL }
        let sdk = makeSDK()
        defer { sdk.shutdown() }
        let configuration = configuration()
        let bundleId = bundleId
        sdk.initialize(bundleId: bundleId, configuration: configuration)

        // One worker serializes lifecycle transitions while the others read.
        // This exercises reference races without overlapping subsystem setup/teardown.
        DispatchQueue.concurrentPerform(iterations: 4) { worker in
            for index in 0 ..< 32 {
                if worker == 0 {
                    sdk.shutdown()
                    sdk.initialize(bundleId: bundleId, configuration: configuration)
                } else {
                    sdk.notifyNavigationEvent(NavigationEvent(destination: "screen-\(index)", source: .custom))
                    sdk.recordWebViewEvent(SdkWebViewEvent(webViewId: "web-\(worker)", name: "event"))
                    _ = sdk.currentSessionId()
                }
            }
        }

        XCTAssertTrue(sdk.isInitialized)
        XCTAssertNotNil(sdk.getEventBuffer())
        sdk.shutdown()
        XCTAssertNil(sdk.getEventBuffer())
        XCTAssertNil(sdk.currentSessionId())
    }
}
