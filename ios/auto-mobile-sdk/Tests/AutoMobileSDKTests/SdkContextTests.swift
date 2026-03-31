import XCTest
@testable import AutoMobileSDK

final class SdkContextTests: XCTestCase {

    // MARK: - SdkContext

    func testDefaultValuesAreNil() {
        let context = SdkContext()
        XCTAssertNil(context.sessionId)
        XCTAssertNil(context.userId)
        XCTAssertNil(context.appVersion)
    }

    func testSetAndGetSessionId() {
        let context = SdkContext()
        context.sessionId = "session-123"
        XCTAssertEqual(context.sessionId, "session-123")
    }

    func testSetAndGetUserId() {
        let context = SdkContext()
        context.userId = "user-456"
        XCTAssertEqual(context.userId, "user-456")
    }

    func testSetAndGetAppVersion() {
        let context = SdkContext()
        context.appVersion = "2.1.0"
        XCTAssertEqual(context.appVersion, "2.1.0")
    }

    func testSetAndRemoveTag() {
        let context = SdkContext()
        context.setTag("env", value: "production")
        XCTAssertEqual(context.snapshot().tags["env"], "production")

        context.removeTag("env")
        XCTAssertNil(context.snapshot().tags["env"])
    }

    func testClearTags() {
        let context = SdkContext()
        context.setTag("a", value: "1")
        context.setTag("b", value: "2")
        context.clearTags()
        XCTAssertTrue(context.snapshot().tags.isEmpty)
    }

    func testSnapshotReturnsCurrentValues() {
        let context = SdkContext()
        context.sessionId = "s1"
        context.userId = "u1"
        context.appVersion = "1.0"
        context.setTag("key", value: "val")

        let snap = context.snapshot()
        XCTAssertEqual(snap.sessionId, "s1")
        XCTAssertEqual(snap.userId, "u1")
        XCTAssertEqual(snap.appVersion, "1.0")
        XCTAssertEqual(snap.tags, ["key": "val"])
    }

    func testSnapshotIsImmutable() {
        let context = SdkContext()
        context.sessionId = "before"
        let snap = context.snapshot()

        context.sessionId = "after"
        XCTAssertEqual(snap.sessionId, "before")
        XCTAssertEqual(context.sessionId, "after")
    }

    func testReset() {
        let context = SdkContext()
        context.sessionId = "s"
        context.userId = "u"
        context.appVersion = "v"
        context.setTag("t", value: "1")

        context.reset()

        XCTAssertNil(context.sessionId)
        XCTAssertNil(context.userId)
        XCTAssertNil(context.appVersion)
        XCTAssertTrue(context.snapshot().tags.isEmpty)
    }

    func testConcurrentAccess() {
        let context = SdkContext()
        let iterations = 100
        let expectation = XCTestExpectation(description: "concurrent access")
        expectation.expectedFulfillmentCount = iterations * 2

        for i in 0..<iterations {
            DispatchQueue.global().async {
                context.sessionId = "session-\(i)"
                context.setTag("key-\(i)", value: "val-\(i)")
                expectation.fulfill()
            }
            DispatchQueue.global().async {
                _ = context.sessionId
                _ = context.snapshot()
                expectation.fulfill()
            }
        }

        wait(for: [expectation], timeout: 5.0)
        // If we get here without crashing, thread safety is confirmed
        XCTAssertNotNil(context.sessionId)
    }

    // MARK: - SdkContextSnapshot

    func testSnapshotEquatable() {
        let a = SdkContextSnapshot(sessionId: "s", userId: "u", appVersion: "1.0", tags: ["k": "v"])
        let b = SdkContextSnapshot(sessionId: "s", userId: "u", appVersion: "1.0", tags: ["k": "v"])
        let c = SdkContextSnapshot(sessionId: "other", userId: "u", appVersion: "1.0", tags: ["k": "v"])
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
    }

    func testSnapshotCodable() throws {
        let original = SdkContextSnapshot(sessionId: "s1", userId: "u1", appVersion: "2.0", tags: ["env": "test"])
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(SdkContextSnapshot.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    // MARK: - SDK Integration

    func testSdkContextCreatedOnInitialize() {
        XCTAssertNil(AutoMobileSDK.shared.sdkContext)
        AutoMobileSDK.shared.initialize(bundleId: "com.test.ctx")
        XCTAssertNotNil(AutoMobileSDK.shared.sdkContext)
    }

    func testSdkContextNilAfterReset() {
        AutoMobileSDK.shared.initialize(bundleId: "com.test.ctx")
        XCTAssertNotNil(AutoMobileSDK.shared.sdkContext)
        AutoMobileSDK.shared.reset()
        XCTAssertNil(AutoMobileSDK.shared.sdkContext)
    }

    func testSdkConvenienceSetUserId() {
        AutoMobileSDK.shared.initialize(bundleId: "com.test.ctx")
        AutoMobileSDK.shared.setUserId("user-99")
        XCTAssertEqual(AutoMobileSDK.shared.sdkContext?.userId, "user-99")
    }

    func testSdkConvenienceSetAndRemoveTag() {
        AutoMobileSDK.shared.initialize(bundleId: "com.test.ctx")
        AutoMobileSDK.shared.setTag("plan", value: "pro")
        XCTAssertEqual(AutoMobileSDK.shared.sdkContext?.snapshot().tags["plan"], "pro")

        AutoMobileSDK.shared.removeTag("plan")
        XCTAssertNil(AutoMobileSDK.shared.sdkContext?.snapshot().tags["plan"])
    }

    override func tearDown() {
        AutoMobileSDK.shared.reset()
        super.tearDown()
    }
}
