@testable import AutoMobilePrototypeAgentCore
import XCTest

/// The per-mode spec forms (#11218) on iOS: the shared fixtures decode into pairs, and every slot
/// resolves against the palette's light or dark mode (#11220).
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

    private func hex(_ value: String) throws -> PrototypeRGBA { try XCTUnwrap(PrototypeRGBA(hex: value)) }

    /// The baseline `scrim` role (black) at the scrim-role opacity.
    private let dim = PrototypeRGBA(red: 0, green: 0, blue: 0, alpha: 0.4)

    private func palette(_ spec: PrototypeSpec, dark: Bool) -> PrototypePalette {
        let palette = PrototypePalette.make(theme: spec.theme, systemDark: dark)
        XCTAssertEqual(palette.dark, dark)
        return palette
    }

    func testASingleValueIsUsedInBothModesAndAPairGivesTheSideForTheMode() throws {
        XCTAssertEqual(try value(#""surface""#), .single("surface"))
        let pair = try value(##"{"light":"#FFFFFF","dark":"scrim"}"##)
        XCTAssertEqual(pair, .modes(light: "#FFFFFF", dark: "scrim"))
        XCTAssertEqual(pair.value(dark: false), "#FFFFFF")
        XCTAssertEqual(pair.value(dark: true), "scrim")
        XCTAssertEqual(PrototypeModeValue.single("surface").value(dark: false), "surface")
        XCTAssertEqual(PrototypeModeValue.single("surface").value(dark: true), "surface")
        XCTAssertEqual(pair.values, ["#FFFFFF", "scrim"])
        XCTAssertEqual(PrototypeModeValue.modes(light: "a", dark: "a").values, ["a"])
    }

    func testAPairMissingAModeWithAnExtraKeyNestedOrOfTheWrongTypeDoesNotDecode() {
        let malformed = [
            #"{"light":"a"}"#, #"{"dark":"a"}"#, "{}", #"{"light":1,"dark":"a"}"#,
            #"{"light":"a","dark":"b","system":"c"}"#, #"{"light":{"light":"a","dark":"b"},"dark":"b"}"#,
            "3", "[]",
        ]
        for json in malformed {
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
        XCTAssertEqual(style.gradient, .linear(angle: 90, stops: [
            PrototypeGradientStop(color: "primary", position: nil),
            PrototypeGradientStop(color: .modes(light: "#FF6200EE", dark: "primaryContainer"), position: 0.5),
            PrototypeGradientStop(color: "#00000000", position: nil),
        ]))
        let children = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(children[0].style?.color, .modes(light: "#0B57D0", dark: "#A8C7FA"))
        XCTAssertEqual(children[1].scrim, .modes(light: "#52000000", dark: "#99000000"))
        XCTAssertEqual(children[2].scrim, "scrim")
        let whenOpen = try XCTUnwrap(spec.root.resolvedStyle(state: ["open": .bool(true)]))
        XCTAssertEqual(whenOpen.background, .modes(light: "surface", dark: "surfaceDim"))
        XCTAssertEqual(whenOpen.gradient, style.gradient, "a styleWhen entry without a gradient keeps the base one")
    }

    /// Every position a pair or a role can appear in, in the light mode.
    func testEveryColourSlotOfTheSharedFixtureResolvesInLightMode() throws {
        let spec = try spec("theme-modes-colors")
        let palette = palette(spec, dark: false)
        let style = try XCTUnwrap(spec.root.style)
        let children = try XCTUnwrap(spec.root.children)
        try XCTAssertEqual(palette.scrim(spec.window.placement.scrim), hex("#66000000"))
        try XCTAssertEqual(palette.resolve(style.background), hex("#FFFFFF"))
        XCTAssertEqual(palette.resolve(style.border?.color), palette.color(role: "outline"))
        XCTAssertNotNil(palette.resolve(style.border?.color))
        try XCTAssertEqual(palette.resolve(style.shadowColor), hex("#40000000"))
        try XCTAssertEqual(palette.resolve(children[0].style?.color), hex("#0B57D0"))
        try XCTAssertEqual(palette.scrim(children[1].scrim), hex("#52000000"))
        XCTAssertEqual(palette.scrim(children[2].scrim), dim, "the scrim role is dimmed, in a sheet scrim")
        let whenOpen = try XCTUnwrap(spec.root.resolvedStyle(state: ["open": .bool(true)]))
        try XCTAssertEqual(palette.resolve(whenOpen.background), hex("#FFFBFE"), "surface from theme.colors.light")
        // Stops: a role (the flat primary override), a pair's hex side, a hex literal.
        try XCTAssertEqual(XCTUnwrap(style.gradient).colorStops(palette: palette), [
            PrototypeGradientColorStop(color: hex("#B3261E"), location: 0),
            PrototypeGradientColorStop(color: hex("#FF6200EE"), location: 0.5),
            PrototypeGradientColorStop(color: hex("#00000000"), location: 1),
        ])
    }

    /// The same positions in the dark mode: the other side of each pair, and roles from the dark
    /// scheme.
    func testEveryColourSlotOfTheSharedFixtureResolvesInDarkMode() throws {
        let spec = try spec("theme-modes-colors")
        let palette = palette(spec, dark: true)
        let style = try XCTUnwrap(spec.root.style)
        let children = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(palette.scrim(spec.window.placement.scrim), dim, "a pair side naming the scrim role")
        try XCTAssertEqual(palette.resolve(style.background), hex("#101014"))
        try XCTAssertEqual(palette.resolve(style.border?.color), hex("#44FFFFFF"))
        try XCTAssertEqual(palette.resolve(style.shadowColor), hex("#000000"), "outside a scrim the role is opaque")
        try XCTAssertEqual(palette.resolve(children[0].style?.color), hex("#A8C7FA"))
        try XCTAssertEqual(palette.scrim(children[1].scrim), hex("#99000000"))
        XCTAssertEqual(palette.scrim(children[2].scrim), dim)
        let whenOpen = try XCTUnwrap(spec.root.resolvedStyle(state: ["open": .bool(true)]))
        XCTAssertEqual(palette.resolve(whenOpen.background), PrototypePalette.baselineDark["surfaceDim"])
        // Stops: the role now comes from theme.colors.dark, and the pair's dark side is a role.
        let stops = try XCTUnwrap(style.gradient).colorStops(palette: palette)
        try XCTAssertEqual(stops.map(\.color), [
            hex("#F2B8B5"),
            XCTUnwrap(palette.color(role: "primaryContainer")),
            hex("#00000000"),
        ])
        XCTAssertEqual(stops.map(\.location), [0, 0.5, 1])
    }

    func testThemeModeMapsAreAppliedAfterTheFlatOverridesForTheResolvedMode() throws {
        let spec = try spec("theme-modes-colors")
        let colors = try XCTUnwrap(spec.theme?.colors)
        XCTAssertEqual(colors.seed, "#6750A4")
        XCTAssertEqual(colors.roles, ["primary": "#B3261E"])
        XCTAssertEqual(colors.light, ["surface": "#FFFBFE", "onSurface": "#1C1B1F"])
        XCTAssertEqual(colors.dark, ["surface": "#1C1B1F", "onSurface": "#E6E1E5", "primary": "#F2B8B5"])
        XCTAssertEqual(colors.unknownKeys, [])

        let light = palette(spec, dark: false)
        try XCTAssertEqual(light.color(role: "primary"), hex("#B3261E"), "the flat override holds in light")
        try XCTAssertEqual(light.color(role: "surface"), hex("#FFFBFE"))
        try XCTAssertEqual(light.color(role: "onSurface"), hex("#1C1B1F"))
        let dark = palette(spec, dark: true)
        try XCTAssertEqual(dark.color(role: "primary"), hex("#F2B8B5"), "the dark map wins over the flat override")
        try XCTAssertEqual(dark.color(role: "surface"), hex("#1C1B1F"))
        try XCTAssertEqual(dark.color(role: "onSurface"), hex("#E6E1E5"))
        // A role in neither map still comes from the seed scheme for that mode.
        XCTAssertEqual(
            dark.color(role: "secondary"),
            try PrototypePalette.seedScheme(seed: hex("#6750A4"), dark: true)["secondary"]
        )
    }

    func testAModeMapNeverDecidesTheModeAndFollowsAnExplicitOne() throws {
        let only = try spec("theme-modes-only-mode-colors")
        XCTAssertEqual(only.theme?.colors?.roles, [:])
        XCTAssertEqual(only.theme?.colors?.dark, ["background": "#000000"])
        let light = PrototypePalette.make(theme: only.theme, systemDark: false)
        XCTAssertFalse(light.dark)
        XCTAssertEqual(light.color(role: "background"), PrototypePalette.baselineLight["background"])
        try XCTAssertEqual(
            PrototypePalette.make(theme: only.theme, systemDark: true).color(role: "background"),
            hex("#000000")
        )

        // No mode at all: a black `dark.background` must not make a light device dark, while the
        // flat background still does, and then the dark map applies.
        let theme = { (json: String) in try JSONDecoder().decode(PrototypeTheme.self, from: Data(json.utf8)) }
        let mapOnly = try PrototypePalette.make(
            theme: theme(##"{"colors":{"dark":{"background":"#000000","surface":"#000000"}}}"##),
            systemDark: false
        )
        XCTAssertFalse(mapOnly.dark)
        let flatDark = try PrototypePalette.make(
            theme: theme(
                ##"{"colors":{"background":"#101010","dark":{"primary":"#ABCDEF"},"light":{"primary":"#123456"}}}"##
            ),
            systemDark: false
        )
        XCTAssertTrue(flatDark.dark)
        try XCTAssertEqual(flatDark.color(role: "primary"), hex("#ABCDEF"))
        let explicitLight = try PrototypePalette.make(
            theme: theme(##"{"mode":"light","colors":{"dark":{"primary":"#ABCDEF"},"light":{"primary":"#123456"}}}"##),
            systemDark: true
        )
        try XCTAssertEqual(explicitLight.color(role: "primary"), hex("#123456"))
    }

    func testAThemelessSpecResolvesAPairFromTheDeviceAppearance() throws {
        let pair = PrototypeModeValue.modes(light: "#111111", dark: "onSurface")
        try XCTAssertEqual(PrototypePalette.make(theme: nil, systemDark: false).resolve(pair), hex("#111111"))
        XCTAssertEqual(
            PrototypePalette.make(theme: nil, systemDark: true).resolve(pair),
            PrototypePalette.baselineDark["onSurface"]
        )
        XCTAssertNil(PrototypePalette.make(theme: nil, systemDark: true).resolve(nil as PrototypeModeValue?))
    }

    func testImagePairsDrawTheAssetForTheModeAndBothIdsAreReferenced() throws {
        let spec = try spec("theme-modes-images")
        let children = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(children[0].asset, .modes(light: "logo-light", dark: "logo-dark"))
        XCTAssertEqual(children[2].asset, "plain")
        XCTAssertEqual(children[3].items?.first?.image, .modes(light: "home-light", dark: "home-dark"))
        let light = PrototypePalette.make(theme: spec.theme, systemDark: false)
        let dark = PrototypePalette.make(theme: spec.theme, systemDark: true)
        XCTAssertEqual(children.prefix(3).map { light.asset($0.asset) }, ["logo-light", "photo", "plain"])
        XCTAssertEqual(children.prefix(3).map { dark.asset($0.asset) }, ["logo-dark", "photo", "plain"])
        XCTAssertNil(light.asset(nil))
        var ids = Set<String>()
        spec.root.collectAssets(into: &ids)
        XCTAssertEqual(ids, ["logo-light", "logo-dark", "photo", "plain", "home-light", "home-dark", "search"])
    }

    func testANavItemDrawsItsModeImageThenItsIconThenAPlaceholder() throws {
        let items = try XCTUnwrap(spec("theme-modes-images").root.children?[3].items)
        let all: Set<String> = ["home-light", "home-dark", "search"]
        XCTAssertEqual(items[0].visual(dark: false, available: all), .image("home-light"))
        XCTAssertEqual(items[0].visual(dark: true, available: all), .image("home-dark"))
        XCTAssertEqual(items[1].visual(dark: true, available: all), .image("search"))
        // Only the light asset is uploaded: dark has nothing to draw and no icon to fall back to.
        XCTAssertEqual(items[0].visual(dark: true, available: ["home-light"]), .placeholder)
        let withIcon = try JSONDecoder().decode(
            NavItem.self,
            from: Data(#"{"label":"Home","icon":"home","image":{"light":"a","dark":"b"}}"#.utf8)
        )
        XCTAssertEqual(withIcon.visual(dark: false, available: ["a"]), .image("a"))
        XCTAssertEqual(withIcon.visual(dark: true, available: ["a"]), .icon("home"))
        let plain = try JSONDecoder().decode(NavItem.self, from: Data(#"{"label":"Home"}"#.utf8))
        XCTAssertEqual(plain.visual(dark: false, available: all), PrototypeNavVisual.none)
    }
}
