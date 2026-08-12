import XCTest
@testable import ScreenCaptureCore

final class CapturePermissionTargetMarkerTests: XCTestCase {
    func testFormatsRuntimeApprovalTargetWithStablePrefix() {
        XCTAssertEqual(
            CapturePermissionTargetMarker.line("AutoMobile"),
            "capture-permission-target: AutoMobile"
        )
    }

    func testPrefersBundleDisplayNameForMacosPermissionPrompt() {
        XCTAssertEqual(
            ScreenRecordingApprovalTarget.resolve(
                bundleDisplayName: "AutoMobile",
                bundleName: "screen-capture-helper"
            ),
            "AutoMobile"
        )
    }

    func testFallsBackToAutoMobileForStandaloneHelper() {
        XCTAssertEqual(
            ScreenRecordingApprovalTarget.resolve(
                bundleDisplayName: nil,
                bundleName: nil
            ),
            "AutoMobile"
        )
    }

    func testNormalizesNewlinesBeforeEmittingTarget() {
        XCTAssertEqual(
            ScreenRecordingApprovalTarget.resolve(
                bundleDisplayName: " Auto\nMobile ",
                bundleName: nil
            ),
            "Auto Mobile"
        )
    }
}
