import XCTest
@testable import ScreenCaptureCore

final class CapturePermissionMarkerTests: XCTestCase {
    func testFormatsScreenRecordingPermissionWithStablePrefix() {
        XCTAssertEqual(
            CapturePermissionMarker.line(.screenRecording),
            "capture-permission: screen-recording"
        )
    }

    func testMarkerIsNotAnErrorLine() {
        XCTAssertFalse(
            CapturePermissionMarker
                .line(.screenRecording)
                .trimmingCharacters(in: .whitespaces)
                .lowercased()
                .hasPrefix("error:")
        )
    }
}
