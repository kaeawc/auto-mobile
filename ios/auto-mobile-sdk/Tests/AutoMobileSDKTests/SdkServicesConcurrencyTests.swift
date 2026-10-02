@testable import AutoMobileSDK
import Foundation
import os
import XCTest

final class SdkServicesConcurrencyTests: XCTestCase {
    func testServiceTypesAreSendable() {
        func requireSendable<T: Sendable>(_: T.Type) {}

        requireSendable(AutoMobileBiometrics.self)
        requireSendable(AutoMobileFailures.self)
        requireSendable(AutoMobileInteractionTracker.self)
        requireSendable(AutoMobileNetwork.self)
        requireSendable(AutoMobileNotifications.self)
        requireSendable(DefaultAutoMobileAPI.self)
        requireSendable(DefaultAutoMobileCrashesAPI.self)
        requireSendable(DefaultAutoMobileNetworkAPI.self)
        requireSendable(ViewBodyTracker.self)
    }

    func testConcurrentBiometricConsumptionIsOneShot() {
        let biometrics = AutoMobileBiometrics.shared
        biometrics.reset()
        defer { biometrics.reset() }
        biometrics.overrideResult(.error(code: 7, message: "injected"), ttlMs: 60000)
        let results = OSAllocatedUnfairLock<[BiometricResult]>(initialState: [])

        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            if let result = biometrics.consumeOverride() {
                results.withLock { $0.append(result) }
            }
        }

        XCTAssertEqual(results.withLock { $0 }, [.error(code: 7, message: "injected")])
        XCTAssertFalse(biometrics.hasOverride)
        biometrics.overrideResult(.success, ttlMs: -1)
        XCTAssertNil(biometrics.consumeOverride())
        XCTAssertFalse(biometrics.hasOverride)
    }

    func testBiometricNotificationCanReenterConsumption() {
        let biometrics = AutoMobileBiometrics.shared
        biometrics.reset()
        defer { biometrics.reset() }
        let results = OSAllocatedUnfairLock<[BiometricResult]>(initialState: [])
        let observer = NotificationCenter.default.addObserver(
            forName: AutoMobileBiometrics.overrideNotification, object: nil, queue: nil
        ) { _ in
            if let result = biometrics.consumeOverride() {
                results.withLock { $0.append(result) }
            }
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        biometrics.overrideResult(.cancel)

        XCTAssertEqual(results.withLock { $0 }, [.cancel])
        XCTAssertFalse(biometrics.hasOverride)
    }

    func testConcurrentFailureRecordingRetainsEveryEvent() {
        let failures = AutoMobileFailures.shared
        failures.reset()
        defer { failures.reset() }
        let buffer = SdkEventBuffer(maxBufferSize: 256, timerFactory: { FakeTimer() }, onFlush: { _ in })
        failures.initialize(bundleId: "concurrency.bundle", buffer: buffer)
        // Match production's main-thread cache before any concurrent recording.
        failures.cacheDeviceInfo()

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            failures.recordHandledException(
                NSError(domain: "failure-\(index)", code: index), message: "message-\(index)"
            )
            _ = failures.getRecentEvents()
        }

        let events = failures.getRecentEvents()
        XCTAssertEqual(failures.eventCount, 32)
        XCTAssertEqual(Set(events.map(\.errorDomain)), Set((0 ..< 32).map { "failure-\($0)" }))
        XCTAssertTrue(events.allSatisfy { $0.bundleId == "concurrency.bundle" })
        XCTAssertTrue(events.allSatisfy { $0.customMessage == $0.errorDomain.replacingOccurrences(
            of: "failure",
            with: "message"
        ) })
    }

    func testConcurrentTapsShareOneDebounceDecisionAndEmitOutsideLock() {
        let tracker = AutoMobileInteractionTracker.shared
        tracker.reset()
        defer { tracker.reset() }
        let events = OSAllocatedUnfairLock<[SdkInteractionEvent]>(initialState: [])
        let buffer = SdkEventBuffer(maxBufferSize: 1, timerFactory: { FakeTimer() }, onFlush: { batch in
            // Capacity flushing must be able to reenter the tracker.
            _ = tracker.isEnabled
            events.withLock { $0.append(contentsOf: batch.compactMap { $0 as? SdkInteractionEvent }) }
        })
        tracker.initialize(bundleId: "concurrency.bundle", buffer: buffer, dateProvider: FakeDateProvider())
        tracker.setEnabled(true)

        // Exactly one contender can advance lastTapProcessedAt in this burst.
        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            tracker.recordTap(x: 12.5, y: 20.3, accessibilityLabel: "Submit", text: "")
        }

        let captured = events.withLock { $0 }
        XCTAssertEqual(captured.count, 1)
        XCTAssertEqual(captured.first?.properties["x"], "12.5")
        XCTAssertEqual(captured.first?.properties["y"], "20.3")
        XCTAssertEqual(captured.first?.properties["accessibilityLabel"], "Submit")
        XCTAssertNil(captured.first?.properties["text"])
    }

    func testConcurrentNotificationSingletonAccessKeepsMetadata() {
        let notifications = AutoMobileNotifications.shared
        let successes = OSAllocatedUnfairLock(initialState: 0)

        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            if AutoMobileNotifications.shared === notifications,
               AutoMobileNotifications.categoryIdentifier == "dev.jasonpearson.automobile.sdk.NOTIFICATION",
               AutoMobileNotifications.actionNotification
               .rawValue == "dev.jasonpearson.automobile.sdk.NOTIFICATION_ACTION"
            {
                successes.withLock { $0 += 1 }
            }
        }

        XCTAssertEqual(successes.withLock { $0 }, 32)
    }

    func testConcurrentDefaultAPIListenerRegistrationAndReentrantDelivery() {
        let api = DefaultAutoMobileAPI()
        api.clearNavigationListeners()
        defer { api.clearNavigationListeners() }
        let deliveries = OSAllocatedUnfairLock(initialState: 0)

        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            _ = api.addNavigationListener { _ in
                _ = api.listenerCount
                deliveries.withLock { $0 += 1 }
            }
        }
        XCTAssertEqual(api.listenerCount, 32)
        api.notifyNavigationEvent(NavigationEvent(destination: "test", source: .custom))
        XCTAssertEqual(deliveries.withLock { $0 }, 32)
    }

    func testConcurrentDefaultCrashesAPIProviderAccess() {
        let api = DefaultAutoMobileCrashesAPI()
        let crashes = AutoMobileCrashes.shared
        let previous = crashes.currentScreenProvider
        defer { api.setCurrentScreenProvider(previous) }
        let successes = OSAllocatedUnfairLock(initialState: 0)

        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            api.setCurrentScreenProvider { "screen" }
            if crashes.currentScreenProvider?() == "screen" {
                successes.withLock { $0 += 1 }
            }
        }

        XCTAssertEqual(successes.withLock { $0 }, 32)
    }

    func testConcurrentNetworkAPIRecordingKeepsCaptureAndEmitsOutsideLock() {
        let api = DefaultAutoMobileNetworkAPI()
        let network = AutoMobileNetwork.shared
        network.reset()
        defer { network.reset() }
        let events = OSAllocatedUnfairLock<[SdkNetworkRequestEvent]>(initialState: [])
        let buffer = SdkEventBuffer(maxBufferSize: 1, timerFactory: { FakeTimer() }, onFlush: { batch in
            _ = network.isEnabled
            events.withLock { $0.append(contentsOf: batch.compactMap { $0 as? SdkNetworkRequestEvent }) }
        })
        network.initialize(bundleId: "concurrency.bundle", buffer: buffer)
        network.setMaxBodyBytes(4)
        api.setCaptureHeaders(true)
        api.setCaptureBodies(true)
        let recorder = api.captureRecorder()

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            api.recordRequest(NetworkRequestRecord(
                url: "https://example.test/\(index)", method: "POST",
                requestHeaders: ["Authorization": "secret", "X-Test": "value"],
                requestBody: "abcdef"
            ))
        }
        let requestId = recorder.beginRequest(url: "https://example.test/recorder", method: "GET")
        recorder.recordCompletion(requestId: requestId, statusCode: 204)

        let captured = events.withLock { $0 }
        XCTAssertEqual(captured.count, 33)
        let posts = captured.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 32)
        XCTAssertTrue(posts.allSatisfy { $0.requestHeaders?["X-Test"] == "value" })
        XCTAssertTrue(posts.allSatisfy { $0.requestHeaders?["Authorization"] != "secret" })
        #if DEBUG
            XCTAssertTrue(posts.allSatisfy { $0.requestBody == "abcd" })
        #else
            XCTAssertTrue(posts.allSatisfy { $0.requestBody == nil })
        #endif
    }

    func testConcurrentViewBodyUpdatesRetainCountsAndDuration() {
        let tracker = ViewBodyTracker.shared
        tracker.reset()
        defer { tracker.reset() }
        let timer = FakeTimer()
        let dateProvider = FakeDateProvider()
        let buffer = SdkEventBuffer(timerFactory: { FakeTimer() }, onFlush: { _ in })
        tracker.initialize(buffer: buffer, dateProvider: dateProvider)
        tracker.setEnabled(true, timerFactory: { timer })

        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            tracker.recordBodyEvaluation(id: "view", viewName: "TestView")
            tracker.recordDuration(id: "view", durationMs: 5)
            _ = tracker.getSnapshots()
        }

        let snapshot = tracker.getSnapshots().first
        XCTAssertEqual(snapshot?.totalCount, 32)
        XCTAssertEqual(snapshot?.rollingAverage, 32)
        XCTAssertEqual(snapshot?.averageDurationMs, 5)
        XCTAssertEqual(snapshot?.viewName, "TestView")
        XCTAssertEqual(timer.intervalMs, 1000)
        tracker.setEnabled(false)
        XCTAssertTrue(timer.isCancelled)
    }

    func testConcurrentViewBodyEnableCreatesOneTimer() {
        let tracker = ViewBodyTracker.shared
        tracker.reset()
        defer { tracker.reset() }
        let creations = OSAllocatedUnfairLock(initialState: 0)
        let timer = FakeTimer()

        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            tracker.setEnabled(true, timerFactory: {
                creations.withLock { $0 += 1 }
                return timer
            })
        }

        XCTAssertEqual(creations.withLock { $0 }, 1)
        XCTAssertTrue(tracker.isEnabled)
        tracker.reset()
        XCTAssertTrue(timer.isCancelled)
        XCTAssertFalse(tracker.isEnabled)
    }
}
