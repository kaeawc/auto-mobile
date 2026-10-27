@testable import AutoMobilePrototypeAgentCore
import XCTest

/// `window.backdrop` on iOS (#15126): Material behind the window, Liquid Glass on iOS 26+, and the
/// tonal fallback under Reduce Transparency or an older OS.
final class PrototypeBackdropTests: XCTestCase {
    private func spec(_ material: String, blur: Int? = nil, tint: String? = nil) -> BackdropSpec {
        BackdropSpec(material: material, blur: blur, tint: tint)
    }

    func testAMaterialBlursOnAnySupportedOS() {
        for material in ["ultraThin", "thin", "regular", "thick"] {
            let plan = PrototypeBackdropPlan.resolve(spec(material), osMajorVersion: 17, reduceTransparency: false)
            XCTAssertEqual(plan.mode, .blur)
            XCTAssertEqual(plan.material.rawValue, material)
        }
    }

    func testReduceTransparencyDrawsTheTonalFillInsteadOfAnOpaqueMaterial() {
        let plan = PrototypeBackdropPlan.resolve(spec("thin"), osMajorVersion: 27, reduceTransparency: true)
        XCTAssertEqual(plan.mode, .fallback)
    }

    func testGlassNeedsIOS26() {
        XCTAssertEqual(
            PrototypeBackdropPlan.resolve(spec("glass"), osMajorVersion: 18, reduceTransparency: false).mode,
            .fallback
        )
        XCTAssertEqual(
            PrototypeBackdropPlan.resolve(spec("glass"), osMajorVersion: 26, reduceTransparency: false).mode,
            .blur
        )
    }

    func testAnAuthoredBlurPicksTheNearestMaterialAndNeverChangesGlass() {
        let near = { (blur: Int) in
            PrototypeBackdropPlan.resolve(
                self.spec("regular", blur: blur), osMajorVersion: 18, reduceTransparency: false
            ).material
        }
        XCTAssertEqual(near(0), .ultraThin)
        XCTAssertEqual(near(10), .ultraThin)
        XCTAssertEqual(near(18), .thin)
        XCTAssertEqual(near(30), .regular)
        XCTAssertEqual(near(150), .thick)
        XCTAssertEqual(
            PrototypeBackdropPlan.resolve(spec("glass", blur: 5), osMajorVersion: 26, reduceTransparency: false)
                .material,
            .glass
        )
    }

    func testTheTintIsCarriedAndTheConstantsMatchAndroid() {
        let plan = PrototypeBackdropPlan.resolve(
            spec("thin", tint: "primary"),
            osMajorVersion: 18,
            reduceTransparency: false
        )
        XCTAssertEqual(plan.tint, "primary")
        XCTAssertEqual(PrototypeBackdropPlan.tonalAlpha, 0.85)
        XCTAssertEqual(PrototypeBackdropPlan.blurTintAlpha, 0.35)
        XCTAssertEqual(PrototypeBackdropPlan.defaultTonalRole, "surfaceContainer")
    }

    func testTheWindowDecodesItsBackdrop() throws {
        let json =
            ##"{"placement":{"type":"fullscreen"},"backdrop":{"material":"thick","blur":12,"tint":"#FF336699"}}"##
        let window = try JSONDecoder().decode(WindowSpec.self, from: Data(json.utf8))
        XCTAssertEqual(window.backdrop, BackdropSpec(material: "thick", blur: 12, tint: "#FF336699"))
        let plain = try JSONDecoder().decode(
            WindowSpec.self, from: Data(#"{"placement":{"type":"fullscreen"}}"#.utf8)
        )
        XCTAssertNil(plain.backdrop)
    }
}
