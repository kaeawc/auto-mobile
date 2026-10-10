@testable import AutoMobilePrototypeAgentCore
import XCTest

/// The per-mode spec forms (#11218) on iOS: the shared fixtures decode into pairs, and everything
/// the renderer draws goes through one seam that still returns the light value (#11220 replaces it).
final class PrototypeModeValueTests: XCTestCase {
    private func spec(_ name: String) throws -> PrototypeSpec {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid/\(name).json")
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
    }

    private func value(_ json: String) throws -> PrototypeModeValue {
        try JSONDecoder().decode(PrototypeModeValue.self, from: Data(json.utf8))
    }

    func testASingleValueAndAPairDecodeAndTheSeamReturnsTheLightSide() throws {
        XCTAssertEqual(try value(#""surface""#), .single("surface"))
        let pair = try value(##"{"light":"#FFFFFF","dark":"scrim"}"##)
        XCTAssertEqual(pair, .modes(light: "#FFFFFF", dark: "scrim"))
        XCTAssertEqual(pair.rendered, "#FFFFFF")
        XCTAssertEqual(PrototypeModeValue.single("surface").rendered, "surface")
        XCTAssertEqual(pair.values, ["#FFFFFF", "scrim"])
        XCTAssertEqual(PrototypeModeValue.modes(light: "a", dark: "a").values, ["a"])
    }

    func testAPairMissingAModeOrOfTheWrongTypeDoesNotDecode() {
        for json in [#"{"light":"a"}"#, #"{"dark":"a"}"#, #"{"light":1,"dark":"a"}"#, "3", "[]"] {
            XCTAssertThrowsError(try value(json), json)
        }
    }

    func testEveryColourSlotOfTheSharedFixtureDecodesItsPair() throws {
        let spec = try spec("theme-modes-colors")
        XCTAssertEqual(spec.window.placement.scrim, .modes(light: "#66000000", dark: "scrim"))
        let style = try XCTUnwrap(spec.root.style)
        XCTAssertEqual(style.background, .modes(light: "#FFFFFF", dark: "#101014"))
        XCTAssertEqual(style.border?.color, .modes(light: "outline", dark: "#44FFFFFF"))
        XCTAssertEqual(style.shadowColor, .modes(light: "#40000000", dark: "scrim"))
        let children = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(children[0].style?.color, .modes(light: "#0B57D0", dark: "#A8C7FA"))
        XCTAssertEqual(children[1].scrim, .modes(light: "#52000000", dark: "#99000000"))
        XCTAssertEqual(children[2].scrim, "scrim")
        let whenOpen = try XCTUnwrap(spec.root.resolvedStyle(state: ["open": .bool(true)]))
        XCTAssertEqual(whenOpen.background, .modes(light: "surface", dark: "surfaceDim"))
    }

    func testThemeModeMapsDecodeAndLeaveThePaletteOnItsFlatOverrides() throws {
        let spec = try spec("theme-modes-colors")
        let colors = try XCTUnwrap(spec.theme?.colors)
        XCTAssertEqual(colors.seed, "#6750A4")
        XCTAssertEqual(colors.roles, ["primary": "#B3261E"])
        XCTAssertEqual(colors.light, ["surface": "#FFFBFE", "onSurface": "#1C1B1F"])
        XCTAssertEqual(colors.dark, ["surface": "#1C1B1F", "onSurface": "#E6E1E5", "primary": "#F2B8B5"])
        // The seam: per-mode maps are decoded but not applied until #11220.
        for systemDark in [false, true] {
            let palette = PrototypePalette.make(theme: spec.theme, systemDark: systemDark)
            XCTAssertEqual(palette.color(role: "primary"), PrototypeRGBA(hex: "#B3261E"))
            XCTAssertEqual(palette.resolve(spec.root.style?.background), PrototypeRGBA(hex: "#FFFFFF"))
        }
        let only = try self.spec("theme-modes-only-mode-colors")
        XCTAssertEqual(only.theme?.colors?.roles, [:])
        XCTAssertEqual(only.theme?.colors?.dark, ["background": "#000000"])
    }

    func testImagePairsDecodeAndBothAssetIdsAreReferenced() throws {
        let spec = try spec("theme-modes-images")
        let children = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(children[0].asset, .modes(light: "logo-light", dark: "logo-dark"))
        XCTAssertEqual(children[0].asset?.rendered, "logo-light")
        XCTAssertEqual(children[2].asset, "plain")
        XCTAssertEqual(children[3].items?.first?.image, .modes(light: "home-light", dark: "home-dark"))
        var ids = Set<String>()
        spec.root.collectAssets(into: &ids)
        XCTAssertEqual(ids, ["logo-light", "logo-dark", "photo", "plain", "home-light", "home-dark", "search"])
    }
}
