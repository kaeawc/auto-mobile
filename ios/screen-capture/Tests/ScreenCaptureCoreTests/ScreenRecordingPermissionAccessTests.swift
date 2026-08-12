import XCTest
@testable import ScreenCaptureCore

final class ScreenRecordingPermissionAccessTests: XCTestCase {
    func testUsesExistingGrantWithoutRequestingAgain() {
        var requestCalls = 0
        let access = ScreenRecordingPermissionAccess(
            preflight: { true },
            request: {
                requestCalls += 1
                return false
            }
        )

        XCTAssertTrue(access.requestIfNeeded())
        XCTAssertEqual(requestCalls, 0)
    }

    func testRequestsScreenRecordingWhenPreflightIsDenied() {
        var requestCalls = 0
        let access = ScreenRecordingPermissionAccess(
            preflight: { false },
            request: {
                requestCalls += 1
                return true
            }
        )

        XCTAssertTrue(access.requestIfNeeded())
        XCTAssertEqual(requestCalls, 1)
    }

    func testReportsDeniedWhenSystemRequestIsDeclined() {
        let access = ScreenRecordingPermissionAccess(
            preflight: { false },
            request: { false }
        )

        XCTAssertFalse(access.requestIfNeeded())
    }
}
