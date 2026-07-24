import XCTest
@testable import ScreenCaptureCore

final class CaptureStartupMarkerTests: XCTestCase {
    func testFormatsEachPhaseWithStablePrefix() {
        XCTAssertEqual(
            CaptureStartupMarker.line(.resolvingWindow(windowID: 32)),
            "capture-phase: resolving-window id=32"
        )
        XCTAssertEqual(
            CaptureStartupMarker.line(.resolvedWindow(windowID: 32, width: 402, height: 874)),
            "capture-phase: resolved-window id=32 size=402x874"
        )
        XCTAssertEqual(
            CaptureStartupMarker.line(.startingCapture(windowID: 32, fps: 15)),
            "capture-phase: starting-capture id=32 fps=15"
        )
        XCTAssertEqual(
            CaptureStartupMarker.line(.captureStarted(windowID: 32)),
            "capture-phase: capture-started id=32"
        )
        XCTAssertEqual(
            CaptureStartupMarker.line(.firstFrame(windowID: 32, width: 804, height: 1748)),
            "capture-phase: first-frame id=32 size=804x1748"
        )
    }

    func testPrefixConstant() {
        XCTAssertEqual(CaptureStartupMarker.prefix, "capture-phase:")
    }

    /// The TS supervisor (`IosH264Source`) treats an `error:`-prefixed helper
    /// line as fatal and a line containing "no frames received" as a permission
    /// denial. Diagnostic markers must trip neither, or they would abort or
    /// misreport the capture (issue #4350).
    func testMarkersAreNotMisclassifiedBySupervisor() {
        let lines = [
            CaptureStartupMarker.line(.resolvingWindow(windowID: 1)),
            CaptureStartupMarker.line(.resolvedWindow(windowID: 1, width: 2, height: 3)),
            CaptureStartupMarker.line(.startingCapture(windowID: 1, fps: 5)),
            CaptureStartupMarker.line(.captureStarted(windowID: 1)),
            CaptureStartupMarker.line(.firstFrame(windowID: 1, width: 2, height: 3)),
        ]
        for line in lines {
            XCTAssertFalse(
                line.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("error:"),
                "marker must not be classified as a fatal helper error: \(line)"
            )
            XCTAssertFalse(
                line.lowercased().contains("no frames received"),
                "marker must not be classified as a permission denial: \(line)"
            )
        }
    }
}
