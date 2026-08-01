import XCTest
@testable import ScreenCaptureCore

final class CaptureCapabilityMarkerTests: XCTestCase {
    func testPrefixConstant() {
        XCTAssertEqual(CaptureCapabilityMarker.prefix, "capture-capability:")
    }

    func testFormatsEncodedVideoCapabilityWithStablePrefix() {
        XCTAssertEqual(
            CaptureCapabilityMarker.line(.encodedVideoH264),
            "capture-capability: encoded-video-h264"
        )
    }

    func testAllLinesCoversEveryCapability() {
        XCTAssertEqual(
            CaptureCapabilityMarker.allLines(),
            CaptureCapability.allCases.map { "capture-capability: \($0.rawValue)" }
        )
        XCTAssertTrue(CaptureCapabilityMarker.allLines().contains("capture-capability: encoded-video-h264"))
    }

    /// The TS supervisor (`IosH264Source`) treats an `error:`-prefixed helper line
    /// as fatal and a line containing "no frames received" as a permission denial.
    /// The handshake must trip neither (mirrors `CaptureStartupMarkerTests`).
    func testMarkersAreNotMisclassifiedBySupervisor() {
        for line in CaptureCapabilityMarker.allLines() {
            XCTAssertFalse(line.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("error:"))
            XCTAssertFalse(line.lowercased().contains("no frames received"))
        }
    }
}
