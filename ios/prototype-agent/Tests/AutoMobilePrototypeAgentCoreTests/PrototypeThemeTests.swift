@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeThemeTests: XCTestCase {
    private func fixture(_ name: String) throws -> PrototypeSpec {
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid")
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: dir.appendingPathComponent(name)))
    }

    private func theme(_ json: String) throws -> PrototypeTheme {
        try JSONDecoder().decode(PrototypeTheme.self, from: Data(json.utf8))
    }

    private func hex(_ value: String) throws -> PrototypeRGBA { try XCTUnwrap(PrototypeRGBA(hex: value)) }

    func testThereAreThirtySixRolesAndEverySchemeCoversThem() {
        XCTAssertEqual(PrototypePalette.roleNames.count, 36)
        XCTAssertEqual(Set(PrototypePalette.baselineDark.keys), PrototypePalette.roleNames)
    }

    func testRoleOverridesFixtureWinsOverTheSeedScheme() throws {
        let spec = try fixture("theme-role-overrides.json")
        let palette = PrototypePalette.make(theme: spec.theme, systemDark: true)
        XCTAssertFalse(palette.dark, "mode light beats a dark device")
        try XCTAssertEqual(palette.color(role: "primary"), hex("#B3261E"))
        try XCTAssertEqual(palette.color(role: "surfaceContainer"), hex("#F3EDF7"))
        // Not overridden: derived from the #6750A4 seed, so it is no longer the baseline value.
        XCTAssertNotEqual(palette.color(role: "secondary"), PrototypePalette.baselineLight["secondary"])
        try XCTAssertEqual(palette.resolve("surfaceContainer"), hex("#F3EDF7"))
        try XCTAssertEqual(palette.resolve("#112233"), hex("#112233"))
    }

    func testColourRoleFixtureNamesResolveFromTheBaselineThemeless() throws {
        let spec = try fixture("color-role-and-corner-tokens.json")
        XCTAssertNil(spec.theme)
        let palette = PrototypePalette.make(theme: spec.theme, systemDark: false)
        XCTAssertFalse(palette.themed)
        let style = try XCTUnwrap(spec.root.style)
        try XCTAssertEqual(palette.resolve(style.background), hex("#F3EDF7"))
        try XCTAssertEqual(palette.resolve(style.border?.color), hex("#79747E"))
        let title = try XCTUnwrap(spec.root.children?.first?.style)
        try XCTAssertEqual(palette.resolve(title.color), hex("#FFFFFF"))
        try XCTAssertEqual(palette.resolve(title.background), hex("#FF6200EE"))
        XCTAssertNil(palette.resolve("notARole"))
        XCTAssertNil(palette.resolve(nil as String?))
    }

    func testModeDecidesLightOrDarkAndSystemFollowsTheDevice() throws {
        XCTAssertTrue(try PrototypePalette.make(theme: theme(##"{"mode":"dark"}"##), systemDark: false).dark)
        XCTAssertFalse(try PrototypePalette.make(theme: theme(##"{"mode":"light"}"##), systemDark: true).dark)
        XCTAssertTrue(try PrototypePalette.make(theme: theme(##"{"mode":"system"}"##), systemDark: true).dark)
        XCTAssertTrue(PrototypePalette.make(theme: nil, systemDark: true).dark)
        let dark = try PrototypePalette.make(theme: theme(##"{"mode":"dark"}"##), systemDark: false)
        XCTAssertEqual(dark.color(role: "surface"), PrototypePalette.baselineDark["surface"])
    }

    func testNoModeInfersFromAnExplicitSurfaceOverride() throws {
        let darkSurface = try theme(##"{"colors":{"background":"#101010"}}"##)
        XCTAssertTrue(PrototypePalette.make(theme: darkSurface, systemDark: false).dark)
        let lightSurface = try theme(##"{"colors":{"surface":"#FAFAFA"}}"##)
        XCTAssertFalse(PrototypePalette.make(theme: lightSurface, systemDark: true).dark)
    }

    func testSeedSchemeKeepsTheSeedHueAndStaysLegible() throws {
        for dark in [false, true] {
            let palette = try PrototypePalette.make(
                theme: theme("{\"mode\":\"\(dark ? "dark" : "light")\",\"colors\":{\"seed\":\"#FFEB3B\"}}"),
                systemDark: false
            )
            let primary = try XCTUnwrap(palette.color(role: "primary"))
            let surface = try XCTUnwrap(palette.color(role: "surface"))
            XCTAssertGreaterThanOrEqual(primary.contrast(with: surface), 3, "yellow seed, dark=\(dark)")
            try XCTAssertEqual(primary.hueAndSaturation.hue, hex("#FFEB3B").hueAndSaturation.hue, accuracy: 6)
        }
    }

    func testGreySeedStaysGreyAndDeviceSourceFallsBackToTheBaseline() throws {
        let grey = try PrototypePalette.make(
            theme: theme(##"{"mode":"light","colors":{"seed":"#808080"}}"##),
            systemDark: false
        )
        XCTAssertEqual(try XCTUnwrap(grey.color(role: "primary")).hueAndSaturation.saturation, 0, accuracy: 0.001)
        let device = try PrototypePalette.make(
            theme: theme(##"{"mode":"light","colors":{"source":"device"}}"##),
            systemDark: false
        )
        XCTAssertEqual(device.colors, PrototypePalette.baselineLight)
    }

    func testHexParsingIsStrict() {
        XCTAssertNil(PrototypeRGBA(hex: "#FFF"))
        XCTAssertNil(PrototypeRGBA(hex: "primary"))
        XCTAssertEqual(PrototypeRGBA(hex: "#80FF0000")?.alpha ?? 0, 128.0 / 255, accuracy: 0.001)
    }

    // MARK: Font assets

    func testFontAssetFixtureIsReportedMissingEvenWithImagesAvailable() throws {
        let spec = try fixture("font-asset.json")
        var session = PrototypeSession()
        session.show(spec)
        XCTAssertEqual(session.fontAssets(), ["brand-font"])
        XCTAssertEqual(session.missingAssets(available: []), ["brand-font"])
        XCTAssertEqual(session.missingAssets(available: ["other"]), ["brand-font"])
    }

    func testSpecWithoutAFontAssetReportsNone() throws {
        var session = PrototypeSession()
        try session.show(fixture("color-role-and-corner-tokens.json"))
        XCTAssertEqual(session.fontAssets(), [])
    }

    // MARK: Typography and shapes

    func testTypographyShapesFixtureDecodes() throws {
        let theme = try XCTUnwrap(fixture("theme-typography-shapes.json").theme)
        XCTAssertEqual(theme.typography, PrototypeThemeTypography(scale: 1.25, fontFamily: "serif"))
        XCTAssertEqual(theme.shapes, PrototypeThemeShapes(corner: "large"))
        let typography = PrototypeTypography(theme: theme.typography)
        XCTAssertEqual(typography.design, .serif)
        XCTAssertEqual(PrototypeShapes(theme: theme.shapes).steps, [8, 12, 20, 28, 40])
    }

    func testTextStyleFixtureScalesSizeAndLineHeightButNotTracking() throws {
        let spec = try fixture("text-style-role.json")
        let typography = PrototypeTypography(theme: spec.theme?.typography)
        let resolved = typography.resolve(spec.root.style)
        XCTAssertEqual(resolved.size, 22 * 0.75, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(resolved.lineHeight), 28 * 0.75, accuracy: 1e-9)
        XCTAssertEqual(resolved.weight, 400)
        XCTAssertEqual(resolved.letterSpacing, 0)
        XCTAssertEqual(resolved.design, .standard)
    }

    func testEveryMaterialRoleIsInTheScale() {
        XCTAssertEqual(PrototypeTypography.roleNames.count, 15)
        let medium = PrototypeTypography.standard.role("titleMedium")
        XCTAssertEqual(medium, PrototypeTextRole(size: 16, weight: 500, lineHeight: 24, letterSpacing: 0.15))
        XCTAssertEqual(PrototypeTypography.standard.role("labelSmall")?.size, 11)
        XCTAssertEqual(PrototypeTypography.standard.role("displayLarge")?.letterSpacing, -0.25)
        XCTAssertNil(PrototypeTypography.standard.role("bogus"))
        XCTAssertNil(PrototypeTypography.standard.role(nil))
    }

    func testExplicitStyleFieldsBeatTheRoleAndNoRoleIsUnscaled() throws {
        let scaled = PrototypeTypography(scale: 1.5, design: .monospaced)
        let style = try JSONDecoder().decode(
            Style.self,
            from: Data(#"{"textStyle":"bodyLarge","textSize":20,"fontWeight":700,"fontFamily":"serif"}"#.utf8)
        )
        let resolved = scaled.resolve(style)
        XCTAssertEqual(resolved.size, 20)
        XCTAssertEqual(resolved.weight, 700)
        XCTAssertEqual(resolved.design, .serif)
        XCTAssertEqual(resolved.lineHeight, 24 * 1.5)
        let plain = scaled.resolve(nil)
        XCTAssertEqual(plain.size, 14, "plain text keeps its authored default, unscaled")
        XCTAssertEqual(plain.design, .monospaced, "plain text takes the theme family")
        XCTAssertNil(plain.lineHeight)
    }

    func testThemeFamilyKeywords() {
        XCTAssertEqual(PrototypeTypography(theme: .init(scale: nil, fontFamily: "mono")).design, .monospaced)
        XCTAssertEqual(PrototypeTypography(theme: .init(scale: nil, fontFamily: "sans")).design, .standard)
        XCTAssertEqual(PrototypeTypography(theme: nil), .standard)
    }

    func testShapeStepsPerCornerChoice() {
        let expected: [(String?, [Double])] = [
            (nil, [4, 8, 12, 16, 28]), ("medium", [4, 8, 12, 16, 28]), ("none", [0, 0, 0, 0, 0]),
            ("small", [2, 4, 6, 8, 12]), ("large", [8, 12, 20, 28, 40]),
        ]
        for (corner, steps) in expected {
            XCTAssertEqual(PrototypeShapes(theme: .init(corner: corner)).steps, steps, corner ?? "nil")
        }
        XCTAssertEqual(PrototypeShapes(theme: .init(corner: "full")).steps, Array(repeating: 9999, count: 5))
    }

    func testCornerTokensResolveThroughTheTheme() {
        let large = PrototypeShapes(theme: .init(corner: "large"))
        XCTAssertEqual(large.resolve(.token("extraSmall")), .uniform(8))
        XCTAssertEqual(large.resolve(.token("extraLarge")), .uniform(40))
        XCTAssertEqual(PrototypeShapes(theme: .init(corner: "none")).resolve(.token("large")), .uniform(0))
        XCTAssertEqual(PrototypeShapes(theme: .init(corner: "small")).resolve(.token("full")), .uniform(9999))
        XCTAssertEqual(large.resolve(.uniform(5)), .uniform(5), "dp radii are not themed")
    }

    func testCornerTokenFixtureStaysATokenUntilResolved() throws {
        let spec = try fixture("color-role-and-corner-tokens.json")
        let radius = try XCTUnwrap(spec.root.style?.cornerRadius)
        guard case .token = radius else { return XCTFail("expected a token, got \(radius)") }
    }
}
