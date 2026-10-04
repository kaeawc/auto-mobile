@testable import AutoMobileSDK
import XCTest

final class AutoMobileFailuresTests: XCTestCase {
    override func tearDown() {
        AutoMobileFailures.shared.reset()
        super.tearDown()
    }

    func testRecordHandledException() {
        AutoMobileFailures.shared.initialize(
            bundleId: "com.test.app",
            buffer: SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { _ in }
        )

        let error = NSError(domain: "TestDomain", code: 42, userInfo: [
            NSLocalizedDescriptionKey: "Something went wrong",
        ])

        AutoMobileFailures.shared.recordHandledException(error, message: "custom msg")

        XCTAssertEqual(AutoMobileFailures.shared.eventCount, 1)
        let events = AutoMobileFailures.shared.getRecentEvents()
        XCTAssertEqual(events.first?.errorDomain, "TestDomain")
        XCTAssertEqual(events.first?.customMessage, "custom msg")
    }

    func testClearEvents() {
        AutoMobileFailures.shared.initialize(
            bundleId: "com.test.app",
            buffer: SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { _ in }
        )

        let error = NSError(domain: "Test", code: 1)
        AutoMobileFailures.shared.recordHandledException(error)
        XCTAssertEqual(AutoMobileFailures.shared.eventCount, 1)

        AutoMobileFailures.shared.clearEvents()
        XCTAssertEqual(AutoMobileFailures.shared.eventCount, 0)
    }

    func testMaxEventsLimit() {
        AutoMobileFailures.shared.initialize(
            bundleId: "com.test.app",
            buffer: SdkEventBuffer(maxBufferSize: 1000, flushIntervalMs: 60000) { _ in }
        )

        for i in 0 ..< 150 {
            let error = NSError(domain: "Test", code: i)
            AutoMobileFailures.shared.recordHandledException(error)
        }

        XCTAssertEqual(AutoMobileFailures.shared.eventCount, 100)
    }

    func testDeviceInfoProviderCanReenterAndRecordedFailureUsesCache() {
        let failures = AutoMobileFailures.shared
        failures.reset()
        let buffer = SdkEventBuffer(timerFactory: { FakeTimer() }, onFlush: { _ in })
        failures.initialize(bundleId: "test.bundle", buffer: buffer)
        let expected = SdkDeviceInfo(model: "fixture", osVersion: "17.0", systemName: "iOS")

        failures.cacheDeviceInfo {
            // Reads the same state lock: device info must be obtained before locking it.
            XCTAssertEqual(failures.eventCount, 0)
            return expected
        }
        failures.recordHandledException(NSError(domain: "cached-device", code: 1))

        let deviceInfo = failures.getRecentEvents().first?.deviceInfo
        XCTAssertEqual(deviceInfo?.model, expected.model)
        XCTAssertEqual(deviceInfo?.osVersion, expected.osVersion)
        XCTAssertEqual(deviceInfo?.systemName, expected.systemName)
    }
}
