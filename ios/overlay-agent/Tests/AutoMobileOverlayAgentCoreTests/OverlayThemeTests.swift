@testable import AutoMobileOverlayAgentCore
import XCTest

final class OverlayThemeTests: XCTestCase {
    private func fixture(_ name: String) throws -> OverlaySpec {
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/overlay-spec/valid")
        return try JSONDecoder().decode(OverlaySpec.self, from: Data(contentsOf: dir.appendingPathComponent(name)))
    }

    private func theme(_ json: String) throws -> OverlayTheme {
        try JSONDecoder().decode(OverlayTheme.self, from: Data(json.utf8))
    }

    private func hex(_ value: String) -> OverlayRGBA { OverlayRGBA(hex: value)! }

    func testThereAreThirtySixRolesAndEverySchemeCoversThem() {
        XCTAssertEqual(OverlayPalette.roleNames.count, 36)
        XCTAssertEqual(Set(OverlayPalette.baselineDark.keys), OverlayPalette.roleNames)
    }

    func testRoleOverridesFixtureWinsOverTheSeedScheme() throws {
        let spec = try fixture("theme-role-overrides.json")
        let palette = OverlayPalette.make(theme: spec.theme, systemDark: true)
        XCTAssertFalse(palette.dark, "mode light beats a dark device")
        XCTAssertEqual(palette.color(role: "primary"), hex("#B3261E"))
        XCTAssertEqual(palette.color(role: "surfaceContainer"), hex("#F3EDF7"))
        // Not overridden: derived from the #6750A4 seed, so it is no longer the baseline value.
        XCTAssertNotEqual(palette.color(role: "secondary"), OverlayPalette.baselineLight["secondary"])
        XCTAssertEqual(palette.resolve("surfaceContainer"), hex("#F3EDF7"))
        XCTAssertEqual(palette.resolve("#112233"), hex("#112233"))
    }

    func testColourRoleFixtureNamesResolveFromTheBaselineThemeless() throws {
        let spec = try fixture("color-role-and-corner-tokens.json")
        XCTAssertNil(spec.theme)
        let palette = OverlayPalette.make(theme: spec.theme, systemDark: false)
        XCTAssertFalse(palette.themed)
        let style = try XCTUnwrap(spec.root.style)
        XCTAssertEqual(palette.resolve(style.background), hex("#F3EDF7"))
        XCTAssertEqual(palette.resolve(style.border?.color), hex("#79747E"))
        let title = try XCTUnwrap(spec.root.children?.first?.style)
        XCTAssertEqual(palette.resolve(title.color), hex("#FFFFFF"))
        XCTAssertEqual(palette.resolve(title.background), hex("#FF6200EE"))
        XCTAssertNil(palette.resolve("notARole"))
        XCTAssertNil(palette.resolve(nil))
    }

    func testModeDecidesLightOrDarkAndSystemFollowsTheDevice() throws {
        XCTAssertTrue(try OverlayPalette.make(theme: theme(##"{"mode":"dark"}"##), systemDark: false).dark)
        XCTAssertFalse(try OverlayPalette.make(theme: theme(##"{"mode":"light"}"##), systemDark: true).dark)
        XCTAssertTrue(try OverlayPalette.make(theme: theme(##"{"mode":"system"}"##), systemDark: true).dark)
        XCTAssertTrue(OverlayPalette.make(theme: nil, systemDark: true).dark)
        let dark = try OverlayPalette.make(theme: theme(##"{"mode":"dark"}"##), systemDark: false)
        XCTAssertEqual(dark.color(role: "surface"), OverlayPalette.baselineDark["surface"])
    }

    func testNoModeInfersFromAnExplicitSurfaceOverride() throws {
        let darkSurface = try theme(##"{"colors":{"background":"#101010"}}"##)
        XCTAssertTrue(OverlayPalette.make(theme: darkSurface, systemDark: false).dark)
        let lightSurface = try theme(##"{"colors":{"surface":"#FAFAFA"}}"##)
        XCTAssertFalse(OverlayPalette.make(theme: lightSurface, systemDark: true).dark)
    }

    func testSeedSchemeKeepsTheSeedHueAndStaysLegible() throws {
        for dark in [false, true] {
            let palette = try OverlayPalette.make(
                theme: theme("{\"mode\":\"\(dark ? "dark" : "light")\",\"colors\":{\"seed\":\"#FFEB3B\"}}"),
                systemDark: false
            )
            let primary = try XCTUnwrap(palette.color(role: "primary"))
            let surface = try XCTUnwrap(palette.color(role: "surface"))
            XCTAssertGreaterThanOrEqual(primary.contrast(with: surface), 3, "yellow seed, dark=\(dark)")
            XCTAssertEqual(primary.hueAndSaturation.hue, hex("#FFEB3B").hueAndSaturation.hue, accuracy: 6)
        }
    }

    func testGreySeedStaysGreyAndDeviceSourceFallsBackToTheBaseline() throws {
        let grey = try OverlayPalette.make(
            theme: theme(##"{"mode":"light","colors":{"seed":"#808080"}}"##),
            systemDark: false
        )
        XCTAssertEqual(try XCTUnwrap(grey.color(role: "primary")).hueAndSaturation.saturation, 0, accuracy: 0.001)
        let device = try OverlayPalette.make(
            theme: theme(##"{"mode":"light","colors":{"source":"device"}}"##),
            systemDark: false
        )
        XCTAssertEqual(device.colors, OverlayPalette.baselineLight)
    }

    func testHexParsingIsStrict() {
        XCTAssertNil(OverlayRGBA(hex: "#FFF"))
        XCTAssertNil(OverlayRGBA(hex: "primary"))
        XCTAssertEqual(OverlayRGBA(hex: "#80FF0000")?.alpha ?? 0, 128.0 / 255, accuracy: 0.001)
    }

    // MARK: Font assets

    func testFontAssetFixtureIsReportedMissingEvenWithImagesAvailable() throws {
        let spec = try fixture("font-asset.json")
        var session = OverlaySession()
        session.show(spec)
        XCTAssertEqual(session.fontAssets(), ["brand-font"])
        XCTAssertEqual(session.missingAssets(available: []), ["brand-font"])
        XCTAssertEqual(session.missingAssets(available: ["other"]), ["brand-font"])
    }

    func testSpecWithoutAFontAssetReportsNone() throws {
        var session = OverlaySession()
        try session.show(fixture("color-role-and-corner-tokens.json"))
        XCTAssertEqual(session.fontAssets(), [])
    }
}
