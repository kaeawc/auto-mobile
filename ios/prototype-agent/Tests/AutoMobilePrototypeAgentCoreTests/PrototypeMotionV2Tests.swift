@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeMotionV2Tests: XCTestCase {
    private struct Accessibility: PrototypeAccessibilityProviding {
        var isReduceMotionEnabled = false
        var prefersCrossFadeTransitions = false
    }

    override static func setUp() {
        super.setUp()
        // Parse the shared contract once outside per-test timing.
        _ = PrototypeMotionTokens.token(property: "scale")
    }

    private func fixture() throws -> PrototypeSpec {
        try JSONDecoder().decode(
            PrototypeSpec.self,
            from: Data(contentsOf: PrototypeSpecFixtures.directory.appendingPathComponent("valid/motion-v2.json"))
        )
    }

    func testCapturedMotionV2ModelAndStyleMerge() throws {
        let children = try XCTUnwrap(fixture().root.children)
        let heart = children[0]
        XCTAssertEqual(heart.animate?.durationMs, 250)
        XCTAssertEqual(heart.animate?.easing, "spring")
        XCTAssertEqual(heart.style?.scale, 1)
        let active = try XCTUnwrap(heart.resolvedStyle(state: ["liked": .bool(true)]))
        XCTAssertEqual(active.scale, 1.4)
        XCTAssertEqual(active.rotation, -10)
        let base = try XCTUnwrap(heart.style)
        XCTAssertEqual(active.merged(with: base).scale, 1)
        XCTAssertEqual(active.merged(with: base).rotation, -10)
        XCTAssertEqual(children[4].zoomable?.maxScale, 4)
        XCTAssertNotNil(children[5].animate)
        XCTAssertNil(children[5].animate?.durationMs)
    }

    func testCapturedZoomableDoubleTapIsRejected() throws {
        let fixture = try PrototypeSpecFixtures.invalid("motion-zoomable-double-tap")
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: JSONEncoder().encode(fixture.spec))) {
            guard case let PrototypeLoadError.invalidSpec(path, _) = $0 else {
                return XCTFail("Expected invalidSpec, got \($0)")
            }
            XCTAssertEqual(path, fixture.expectedPath)
        }
    }

    func testCapturedMotionV2BoundsAndEasingAreValidated() throws {
        let boundary = try JSONDecoder().decode(
            PrototypeSpec.self,
            from: Data(contentsOf: PrototypeSpecFixtures.directory.appendingPathComponent(
                "valid/strict-bound-037-zoomable-maxScale-boundary.json"
            ))
        )
        XCTAssertEqual(boundary.root.children?[4].zoomable?.maxScale, 8)
        for name in [
            "motion-animate-unknown-easing", "motion-animate-duration-over-max",
            "motion-style-scale-over-max", "motion-style-rotation-over-max",
            "motion-zoomable-max-scale-below-min",
        ] {
            let fixture = try PrototypeSpecFixtures.invalid(name)
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: JSONEncoder().encode(fixture.spec))) {
                guard case let PrototypeLoadError.invalidSpec(path, _) = $0 else {
                    return XCTFail("Expected invalidSpec, got \($0)")
                }
                XCTAssertEqual(path, fixture.expectedPath, name)
            }
        }
    }

    func testHorizontalAndScaleTransitionMapping() throws {
        let children = try XCTUnwrap(fixture().root.children)
        let motion = PrototypeMotion(specMotion: nil, reduceMotion: false, accessibility: Accessibility())
        XCTAssertEqual(motion.visibility(transition: children[1].transition), .slideStart)
        XCTAssertEqual(motion.visibility(transition: children[2].transition), .slideEnd)
        XCTAssertEqual(motion.visibility(transition: children[3].transition), .scale)
        XCTAssertEqual(motion.visibility(transition: "slideStart", nodeType: "stack"), .standard)
    }

    func testMotionV2UsesInjectedAccessibilityAndSpecMotion() {
        for transition in ["slideStart", "slideEnd", "scale"] {
            let off = PrototypeMotion(specMotion: "none", reduceMotion: false, accessibility: Accessibility())
            XCTAssertEqual(off.visibility(transition: transition), .instant)
            for accessibility in [
                Accessibility(isReduceMotionEnabled: true),
                Accessibility(prefersCrossFadeTransitions: true),
            ] {
                let reduced = PrototypeMotion(specMotion: nil, reduceMotion: false, accessibility: accessibility)
                XCTAssertFalse(reduced.spatial)
                // Preserve the existing reduced-profile crossfade; spatial movement snaps.
                XCTAssertEqual(reduced.visibility(transition: transition), .fade)
            }
        }
    }

    func testZoomClampsScalePanAndResizesWithoutTime() {
        var zoom = PrototypeImageZoom()
        let size = CGSize(width: 200, height: 100)
        zoom.update(scale: 20, pan: CGSize(width: 500, height: -500), size: size, maxScale: 2)
        XCTAssertEqual(zoom.scale, 2)
        XCTAssertEqual(zoom.pan, CGSize(width: 100, height: -50))
        zoom.update(scale: zoom.scale, pan: zoom.pan, size: CGSize(width: 100, height: 40), maxScale: 2)
        XCTAssertEqual(zoom.pan, CGSize(width: 50, height: -20))
        zoom.update(scale: 0, pan: zoom.pan, size: size, maxScale: 2)
        XCTAssertEqual(zoom.scale, 1)
        XCTAssertEqual(zoom.pan, .zero)
    }

    func testZoomToggleAndAccessibilityStepsMatchAndroid() {
        var zoom = PrototypeImageZoom()
        let size = CGSize(width: 200, height: 100)
        zoom.update(scale: zoom.toggledScale(maxScale: 1.5), pan: .zero, size: size, maxScale: 1.5)
        XCTAssertEqual(zoom.scale, 1.5)
        XCTAssertEqual(zoom.toggledScale(maxScale: 4), 1)
        XCTAssertEqual(zoom.zoomInScale(maxScale: 2), 2)
        XCTAssertEqual(zoom.zoomOutScale, 1)
        zoom.update(scale: 1, pan: .zero, size: size, maxScale: 4)
        XCTAssertEqual(zoom.toggledScale(maxScale: 4), 2)
        XCTAssertEqual(zoom.zoomInScale(maxScale: 4), 1.5)
    }

    func testMotionV2IsAdvertisedExactlyOnce() {
        XCTAssertEqual(PrototypeAgentProtocol.capabilities.filter { $0 == "prototype_motion_v2" }.count, 1)
        XCTAssertTrue(PrototypeAgentProtocol.advertisedCapabilities().contains("prototype_motion_v2"))
        XCTAssertTrue(AutoMobilePrototypeCapabilities.supported.contains("prototype_motion_v2"))
    }
}
