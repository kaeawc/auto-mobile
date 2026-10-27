@testable import AutoMobilePrototypeAgentCore
import SwiftUI
import XCTest

final class PrototypePressScaleGestureTests: XCTestCase {
    private func style(_ json: String) throws -> Style {
        try JSONDecoder().decode(Style.self, from: Data(json.utf8))
    }

    func testUnspecifiedPressScaleDoesNotInstallGesture() throws {
        XCTAssertFalse(try style("{}").hasPressScaleGesture)
        XCTAssertFalse(try style(#"{"pressScale":null}"#).hasPressScaleGesture)
    }

    func testExplicitIdentityAndSmallerScaleInstallGesture() throws {
        for scale in [1.0, 0.95] {
            let style = try style("{\"pressScale\":\(scale)}")
            XCTAssertTrue(style.hasPressScaleGesture)
            XCTAssertEqual(style.scale(pressed: true), scale)
            XCTAssertEqual(style.scale(pressed: false), 1)
        }
    }

    func testMotionNoneOnlyRemovesAnimation() throws {
        let motion = PrototypeMotion(specMotion: "none", reduceMotion: false)
        XCTAssertNil(motion.pressScaleDuration)
        XCTAssertTrue(try style(#"{"pressScale":0.9}"#).hasPressScaleGesture)
        XCTAssertFalse(try style("{}").hasPressScaleGesture)
    }
}

final class PrototypeEffectiveSafeInsetsTests: XCTestCase {
    private let window = CGRect(x: 0, y: 0, width: 390, height: 844)
    private let insets = PrototypeSafeInsets(top: 47, bottom: 34)

    private func effective(
        _ frame: CGRect, viewInsets: PrototypeSafeInsets = PrototypeSafeInsets()
    )
        -> PrototypeSafeInsets
    {
        prototypeEffectiveSafeInsets(
            viewFrameInWindow: frame, windowBounds: window, windowInsets: insets, viewInsets: viewInsets
        )
    }

    func testViewInsideSafeAreaNeedsNoAdditionalInsets() {
        XCTAssertEqual(effective(CGRect(x: 0, y: 47, width: 390, height: 763)), PrototypeSafeInsets())
    }

    func testBottomIndicatorFullAndPartialOverlap() {
        XCTAssertEqual(effective(CGRect(x: 0, y: 100, width: 390, height: 744)), PrototypeSafeInsets(bottom: 34))
        XCTAssertEqual(effective(CGRect(x: 0, y: 100, width: 390, height: 720)), PrototypeSafeInsets(bottom: 10))
    }

    func testTopNotchFullAndPartialOverlap() {
        XCTAssertEqual(effective(CGRect(x: 0, y: 0, width: 390, height: 200)), PrototypeSafeInsets(top: 47))
        XCTAssertEqual(effective(CGRect(x: 0, y: 30, width: 390, height: 200)), PrototypeSafeInsets(top: 17))
    }

    func testLandscapeSideInsetsAndNonzeroWindowOrigin() {
        let result = prototypeEffectiveSafeInsets(
            viewFrameInWindow: CGRect(x: 30, y: 20, width: 814, height: 370),
            windowBounds: CGRect(x: 10, y: 20, width: 844, height: 390),
            windowInsets: PrototypeSafeInsets(left: 47, bottom: 21, right: 47),
            viewInsets: PrototypeSafeInsets()
        )
        XCTAssertEqual(result, PrototypeSafeInsets(left: 27, bottom: 1, right: 37))
    }

    func testTakesPerEdgeMaximumOfViewAndWindowOverlap() {
        XCTAssertEqual(
            effective(window, viewInsets: PrototypeSafeInsets(top: 60, left: 5, bottom: 12, right: 8)),
            PrototypeSafeInsets(top: 60, left: 5, bottom: 34, right: 8)
        )
    }

    func testNegativeOriginClipsToWindowAndTinyViewsCapOverlap() {
        XCTAssertEqual(effective(CGRect(x: -10, y: -20, width: 420, height: 900)), insets)
        XCTAssertEqual(effective(CGRect(x: 10, y: 10, width: 10, height: 5)), PrototypeSafeInsets(top: 5))
    }

    func testDegenerateNegativeSizedAndOffWindowFramesPreserveReportedInsets() {
        let reported = PrototypeSafeInsets(bottom: 7)
        for frame in [
            CGRect.zero, CGRect(x: 0, y: 0, width: -390, height: 844),
            CGRect(x: 0, y: 0, width: 390, height: -844),
            CGRect(x: 500, y: 0, width: 10, height: 844),
            CGRect(x: 0, y: 900, width: 390, height: 10), .null, .infinite,
        ] {
            XCTAssertEqual(effective(frame, viewInsets: reported), reported)
        }
    }

    func testInvalidWindowAndNegativeInsetsCannotCreatePadding() {
        XCTAssertEqual(prototypeEffectiveSafeInsets(
            viewFrameInWindow: window, windowBounds: .zero, windowInsets: insets,
            viewInsets: PrototypeSafeInsets(bottom: 5)
        ), PrototypeSafeInsets(bottom: 5))
        XCTAssertEqual(prototypeEffectiveSafeInsets(
            viewFrameInWindow: window, windowBounds: window,
            windowInsets: PrototypeSafeInsets(top: -10, bottom: -20),
            viewInsets: PrototypeSafeInsets(left: -5)
        ), PrototypeSafeInsets())
    }
}

final class PrototypeAppearanceReportTests: XCTestCase {
    func testMapsResolvedModesToColorSchemes() {
        XCTAssertEqual(PrototypeChromeAppearance(dark: false).colorScheme, .light)
        XCTAssertEqual(PrototypeChromeAppearance(dark: true).colorScheme, .dark)
    }

    func testReportsInitialLightAndDeduplicatesRepeatedReports() {
        var report = PrototypeAppearanceReport()
        XCTAssertEqual(report.report(dark: false), .light)
        XCTAssertNil(report.report(dark: false))
        XCTAssertEqual(report.report(dark: true), .dark)
        XCTAssertNil(report.report(dark: true))
        XCTAssertEqual(report.report(dark: false), .light)
    }

    func testFreshPresentationReportsDarkEvenWhenPreviousPresentationWasDark() {
        var first = PrototypeAppearanceReport()
        var second = PrototypeAppearanceReport()
        XCTAssertEqual(first.report(dark: true), .dark)
        XCTAssertNil(first.report(dark: true))
        XCTAssertEqual(second.report(dark: true), .dark)
    }
}
