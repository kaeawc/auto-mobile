import XCTest
@testable import AutoMobileSDK

final class ConfigurationTests: XCTestCase {
    override func tearDown() {
        AutoMobileSDK.shared.reset()
        super.tearDown()
    }

    func testDefaultValues() {
        let config = AutoMobileConfiguration()
        XCTAssertEqual(config.bufferSize, 50)
        XCTAssertEqual(config.flushIntervalMs, 500)
        XCTAssertEqual(config.maxBreadcrumbs, 100)
        XCTAssertEqual(config.sessionTimeoutMs, 30_000)

        // Static .default returns the same default values.
        let staticDefault = AutoMobileConfiguration.default
        XCTAssertEqual(staticDefault.bufferSize, config.bufferSize)
        XCTAssertEqual(staticDefault.flushIntervalMs, config.flushIntervalMs)
        XCTAssertEqual(staticDefault.maxBreadcrumbs, config.maxBreadcrumbs)
        XCTAssertEqual(staticDefault.sessionTimeoutMs, config.sessionTimeoutMs)
    }

    func testCustomValues() {
        let config = AutoMobileConfiguration(
            bufferSize: 200,
            flushIntervalMs: 1000,
            maxBreadcrumbs: 50,
            sessionTimeoutMs: 60_000
        )
        XCTAssertEqual(config.bufferSize, 200)
        XCTAssertEqual(config.flushIntervalMs, 1000)
        XCTAssertEqual(config.maxBreadcrumbs, 50)
        XCTAssertEqual(config.sessionTimeoutMs, 60_000)
    }

    func testCustomConfigurationPropagates() {
        let config = AutoMobileConfiguration(
            bufferSize: 200,
            flushIntervalMs: 1000,
            maxBreadcrumbs: 50,
            sessionTimeoutMs: 60_000
        )
        AutoMobileSDK.shared.initialize(bundleId: "com.test.app", configuration: config)

        let stored = AutoMobileSDK.shared.configuration
        XCTAssertNotNil(stored)
        XCTAssertEqual(stored?.bufferSize, 200)
        XCTAssertEqual(stored?.flushIntervalMs, 1000)
        XCTAssertEqual(stored?.maxBreadcrumbs, 50)
        XCTAssertEqual(stored?.sessionTimeoutMs, 60_000)
    }

    func testDefaultInitializeDelegatesToDefaultConfig() {
        AutoMobileSDK.shared.initialize(bundleId: "com.test.app")

        let stored = AutoMobileSDK.shared.configuration
        XCTAssertNotNil(stored)
        XCTAssertEqual(stored?.bufferSize, 50)
        XCTAssertEqual(stored?.flushIntervalMs, 500)
        XCTAssertEqual(stored?.maxBreadcrumbs, 100)
        XCTAssertEqual(stored?.sessionTimeoutMs, 30_000)
    }

    func testConfigurationIsSendable() {
        // Compile-time check: assign to a Sendable-constrained value.
        let config = AutoMobileConfiguration()
        let sendable: any Sendable = config
        XCTAssertNotNil(sendable)
    }

    func testResetClearsConfiguration() {
        AutoMobileSDK.shared.initialize(bundleId: "com.test.app")
        XCTAssertNotNil(AutoMobileSDK.shared.configuration)

        AutoMobileSDK.shared.reset()
        XCTAssertNil(AutoMobileSDK.shared.configuration)
    }
}
