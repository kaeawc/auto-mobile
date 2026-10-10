@testable import AutoMobilePrototypeAgentCore
import XCTest

/// `prototype_theme_modes_v1` on iOS (#11220): gradient decoding and geometry, the capability,
/// and the on-device check that stands in for the host validator the agent does not have.
final class PrototypeThemeModesTests: XCTestCase {
    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func spec(_ json: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    /// The `spec` of an `invalid/<name>.json` fixture, which wraps it with its `expectedPath`.
    private func decodeInvalid(_ name: String) throws -> PrototypeSpec {
        let data = try Data(contentsOf: fixtures.appendingPathComponent("invalid/\(name).json"))
        let wrapper = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], name)
        let spec = try XCTUnwrap(wrapper["spec"], name)
        return try JSONDecoder().decode(PrototypeSpec.self, from: JSONSerialization.data(withJSONObject: spec))
    }

    private func gradient(_ json: String) throws -> PrototypeGradient {
        try JSONDecoder().decode(PrototypeGradient.self, from: Data(json.utf8))
    }

    private func hex(_ value: String) throws -> PrototypeRGBA { try XCTUnwrap(PrototypeRGBA(hex: value)) }

    private let light = PrototypePalette.make(theme: nil, systemDark: false)
    private let dark = PrototypePalette.make(theme: nil, systemDark: true)

    // MARK: Capability

    func testTheAgentAdvertisesThemeModes() {
        XCTAssertEqual(PrototypeAgentProtocol.themeModesCapability, "prototype_theme_modes_v1")
        XCTAssertEqual(PrototypeAgentProtocol.capabilities, [
            "show_prototype", "dismiss_prototype", "put_prototype_asset", "remove_prototype_asset",
            "get_prototype_status", "prototype_show_in_place_v1", "prototype_anchor_v1", "hide_for_capture",
            "restore_after_capture", "screenshot_hide_prototype_v1", "prototype_inspect_v1",
            "prototype_theme_modes_v1",
        ])
    }

    // MARK: Gradient

    func testLinearAndRadialGradientsDecode() throws {
        XCTAssertEqual(
            try gradient(
                ##"{"type":"linear","angle":45,"stops":[{"color":"#FF0000"},{"color":"primary","position":1}]}"##
            ),
            .linear(angle: 45, stops: [
                PrototypeGradientStop(color: "#FF0000", position: nil),
                PrototypeGradientStop(color: "primary", position: 1),
            ])
        )
        let radial = try gradient(
            ##"{"type":"radial","stops":[{"color":{"light":"#FFFFFF","dark":"surface"}},{"color":"#000000"}]}"##
        )
        XCTAssertEqual(radial, .radial(stops: [
            PrototypeGradientStop(color: .modes(light: "#FFFFFF", dark: "surface"), position: nil),
            PrototypeGradientStop(color: "#000000", position: nil),
        ]))
        XCTAssertEqual(radial.stops.count, 2)
    }

    func testAMalformedGradientDoesNotDecode() {
        let stop = ##"{"color":"#000000"}"##
        let malformed = [
            #"{"type":"linear","stops":[\#(stop),\#(stop)]}"#,
            #"{"type":"conic","stops":[\#(stop),\#(stop)]}"#,
            #"{"stops":[\#(stop),\#(stop)]}"#,
            #"{"type":"radial","stops":[\#(stop)]}"#,
            #"{"type":"radial","stops":[\#(stop),\#(stop),\#(stop),\#(stop),\#(stop)]}"#,
            ##"{"type":"radial","stops":[{"color":"#000000","position":1.5},\##(stop)]}"##,
            ##"{"type":"radial","stops":[{"color":"#000000","position":-0.1},\##(stop)]}"##,
            ##"{"type":"radial","stops":[{"color":{"light":"#000000"}},\##(stop)]}"##,
            #"{"type":"radial","stops":[{"position":0},\#(stop)]}"#,
            #"{"type":"radial"}"#,
        ]
        for json in malformed {
            XCTAssertThrowsError(try gradient(json), json)
        }
    }

    func testStopsResolveForTheModeAndAreSpreadEvenlyWithoutPositions() throws {
        let gradient = try gradient(
            ##"{"type":"radial","stops":[{"color":"primary"},{"color":{"light":"#112233","dark":"onSurface"}},{"color":"#80FFFFFF"},{"color":"surface"}]}"##
        )
        let lightStops = gradient.colorStops(palette: light)
        XCTAssertEqual(lightStops.map(\.location), [0, 1.0 / 3, 2.0 / 3, 1])
        try XCTAssertEqual(lightStops.map(\.color), [
            XCTUnwrap(PrototypePalette.baselineLight["primary"]), hex("#112233"), hex("#80FFFFFF"),
            XCTUnwrap(PrototypePalette.baselineLight["surface"]),
        ])
        try XCTAssertEqual(gradient.colorStops(palette: dark).map(\.color), [
            XCTUnwrap(PrototypePalette.baselineDark["primary"]),
            XCTUnwrap(PrototypePalette.baselineDark["onSurface"]),
            hex("#80FFFFFF"),
            XCTUnwrap(PrototypePalette.baselineDark["surface"]),
        ])
    }

    func testAuthoredPositionsApplyOnlyWhenEveryStopHasOneAndNeverDecrease() throws {
        let all = try gradient(
            ##"{"type":"radial","stops":[{"color":"#000000","position":0.2},{"color":"#000001","position":0.8},{"color":"#000002","position":0.5}]}"##
        )
        XCTAssertEqual(all.colorStops(palette: light).map(\.location), [0.2, 0.8, 0.8])
        let mixed = try gradient(
            ##"{"type":"radial","stops":[{"color":"#000000","position":0.2},{"color":"#000001"},{"color":"#000002","position":0.5}]}"##
        )
        XCTAssertEqual(mixed.colorStops(palette: light).map(\.location), [0, 0.5, 1])
    }

    /// A stop that resolves to nothing (only reachable by decoding a gradient outside a spec) is
    /// transparent, as on Android, never another colour.
    func testAnUnresolvableStopIsTransparent() throws {
        let gradient = try gradient(##"{"type":"radial","stops":[{"color":"nope"},{"color":"#12345"}]}"##)
        let clear = PrototypeRGBA(red: 0, green: 0, blue: 0, alpha: 0)
        XCTAssertEqual(gradient.colorStops(palette: dark).map(\.color), [clear, clear])
    }

    func testTheLinearLineMatchesAndroidsForABox() {
        func assertLine(
            _ angle: Double, _ width: Double, _ height: Double,
            _ start: (Double, Double), _ end: (Double, Double), line: UInt = #line
        ) {
            let actual = PrototypeGradient.linearLine(angle: angle, width: width, height: height)
            XCTAssertEqual(actual.start.x, start.0, accuracy: 1e-9, line: line)
            XCTAssertEqual(actual.start.y, start.1, accuracy: 1e-9, line: line)
            XCTAssertEqual(actual.end.x, end.0, accuracy: 1e-9, line: line)
            XCTAssertEqual(actual.end.y, end.1, accuracy: 1e-9, line: line)
        }
        assertLine(0, 100, 50, (0, 0.5), (1, 0.5))
        assertLine(90, 100, 50, (0.5, 0), (0.5, 1))
        assertLine(180, 100, 50, (1, 0.5), (0, 0.5))
        assertLine(270, 100, 50, (0.5, 1), (0.5, 0))
        // Android: half = (|100 cos| + |50 sin|) / 2 = 53.033 px along (cos, sin) from the centre,
        // so the line starts at (12.5, -12.5) px and ends at (87.5, 62.5) px.
        assertLine(45, 100, 50, (0.125, -0.25), (0.875, 1.25))
        assertLine(45, 80, 80, (0, 0), (1, 1))
        // An empty box keeps the line finite.
        assertLine(45, 0, 0, (0.5, 0.5), (0.5, 0.5))
    }

    func testTheRadialRadiusReachesTheCorners() {
        XCTAssertEqual(PrototypeGradient.radialRadius(width: 60, height: 80), 50)
        XCTAssertEqual(PrototypeGradient.radialRadius(width: 0, height: 0), 0)
    }

    func testAGradientCountsAsAnAuthoredFillAndMergesLikeAnyStyleProperty() throws {
        let style = { (json: String) in try JSONDecoder().decode(Style.self, from: Data(json.utf8)) }
        let stops = ##""stops":[{"color":"#000000"},{"color":"#FFFFFF"}]"##
        let base = try style(#"{"gradient":{"type":"radial",\#(stops)}}"#)
        XCTAssertTrue(base.hasAuthoredFill)
        XCTAssertTrue(try style(##"{"background":"#000000"}"##).hasAuthoredFill)
        XCTAssertFalse(try style(#"{"padding":{"top":1}}"#).hasAuthoredFill)
        let replaced = try base.merged(with: style(#"{"gradient":{"type":"linear","angle":0,\#(stops)}}"#))
        guard case .linear? = replaced.gradient else { return XCTFail("the styleWhen gradient replaces the base one") }
        XCTAssertEqual(try base.merged(with: style("{}")).gradient, base.gradient)
    }

    // MARK: Malformed forms fail the show

    /// Every shared invalid fixture for a form the capability added is refused by decoding, which
    /// the agent answers with `Invalid prototype spec`: none of them draws as something else.
    func testEverySharedInvalidFixtureForAThemeModesFormFailsToDecode() throws {
        let names = [
            "color-pair-bad-hex", "color-pair-bad-role", "color-pair-empty", "color-pair-missing-dark",
            "color-pair-missing-light", "color-pair-nested", "color-pair-unknown-key",
            "gradient-bad-position", "gradient-five-stops", "gradient-linear-no-angle", "gradient-one-stop",
            "gradient-stop-bad-role", "gradient-stop-pair-missing-dark", "gradient-unknown-type",
            "image-pair-empty-id", "image-pair-missing-dark", "image-pair-unknown-key",
            "nav-image-pair-missing-light", "scrim-pair-missing-light", "sheet-scrim-bad-role",
            "theme-mode-colors-empty", "theme-mode-colors-not-object", "theme-mode-colors-role-value",
            "theme-mode-colors-seed", "theme-mode-colors-unknown-role",
        ]
        for name in names {
            XCTAssertThrowsError(try decodeInvalid(name), name) { error in
                XCTAssertTrue(error is DecodingError, "\(name): \(error)")
            }
        }
        // Every invalid fixture named for these forms is in the list above or the limits below.
        let onDisk = try FileManager.default
            .contentsOfDirectory(atPath: fixtures.appendingPathComponent("invalid").path)
            .map { String($0.dropLast(".json".count)) }
            .filter { name in
                [
                    "color-pair-",
                    "gradient-",
                    "image-pair-",
                    "nav-image-pair-",
                    "scrim-pair-",
                    "sheet-scrim-",
                    "theme-mode-colors-",
                    "theme-modes-",
                ].contains { name.hasPrefix($0) }
            }
        XCTAssertEqual(Set(onDisk), Set(names + imageLimitFixtures))
    }

    private let imageLimitFixtures = [
        "theme-modes-image-limit", "theme-modes-nav-image-limit", "theme-modes-repeat-image-limit-expanded",
    ]

    /// The image-count limit is the host's alone, for pairs as for single ids: the agent has no
    /// image limit, and a spec over it is well formed, so it decodes and draws the same images.
    func testAnImageCountOverTheHostLimitStillDecodesAndResolves() throws {
        for name in imageLimitFixtures {
            let spec = try decodeInvalid(name)
            var ids = Set<String>()
            spec.root.collectAssets(into: &ids)
            XCTAssertFalse(ids.isEmpty, name)
            XCTAssertTrue(ids.allSatisfy { !$0.isEmpty }, name)
        }
    }

    func testTheErrorNamesTheOffendingPath() throws {
        let cases = [
            ("color-pair-bad-hex", "root.style.shadowColor.light"),
            ("gradient-stop-bad-role", "root.style.gradient.stops[0].color"),
            ("sheet-scrim-bad-role", "root.scrim"),
            ("image-pair-empty-id", "root.asset.light"),
            ("theme-mode-colors-empty", "theme.colors.light"),
            ("theme-mode-colors-role-value", "theme.colors.light.primary"),
            ("theme-mode-colors-seed", "theme.colors.dark.seed"),
        ]
        for (name, path) in cases {
            XCTAssertThrowsError(try decodeInvalid(name), name) { error in
                XCTAssertTrue("\(error)".contains("\(path): "), "\(name): \(error)")
            }
        }
    }

    func testEveryPositionOfAPairOrRoleIsChecked() {
        let window = #""window":{"placement":{"type":"fullscreen"}}"#
        let bad = ##"{"light":"#FFFFFF","dark":"notARole"}"##
        let specs = [
            #"{"id":"p","window":{"placement":{"type":"fullscreen","scrim":\#(bad)}},"root":{"type":"spacer"}}"#,
            #"{"id":"p","window":{"placement":{"type":"fullscreen","scrim":"notARole"}},"root":{"type":"spacer"}}"#,
            ##"{"id":"p","window":{"placement":{"type":"fullscreen","scrim":"#+12345"}},"root":{"type":"spacer"}}"##,
            #"{"id":"p",\#(window),"root":{"type":"box","style":{"background":\#(bad)}}}"#,
            #"{"id":"p",\#(window),"root":{"type":"text","text":"x","style":{"color":\#(bad)}}}"#,
            #"{"id":"p",\#(window),"root":{"type":"box","style":{"border":{"width":1,"color":\#(bad)}}}}"#,
            #"{"id":"p",\#(window),"root":{"type":"box","style":{"shadowColor":\#(bad)}}}"#,
            #"{"id":"p",\#(window),"state":{"on":true},"root":{"type":"box","styleWhen":[{"when":{"key":"on","equals":true},"style":{"background":\#(bad)}}]}}"#,
            #"{"id":"p",\#(window),"root":{"type":"column","children":[{"type":"box","child":{"type":"box","style":{"background":\#(bad)}}}]}}"#,
            #"{"id":"p",\#(window),"root":{"type":"image","asset":{"light":"a","dark":""}}}"#,
            #"{"id":"p",\#(window),"state":{"t":0},"root":{"type":"tabBar","stateKey":"t","items":[{"label":"a","image":{"light":"","dark":"b"}}]}}"#,
        ]
        for json in specs {
            XCTAssertThrowsError(try spec(json), json)
        }
    }

    /// Slots that predate the capability keep their behaviour for a single value: it decodes, and
    /// an unknown one resolves to nothing, which draws that slot's fallback.
    func testASingleUnknownValueInAnOlderSlotStillDecodesAndResolvesToNothing() throws {
        let spec = try spec(
            ##"{"id":"p","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"x","style":{"color":"notARole","background":"#12"}}}"##
        )
        XCTAssertNil(light.resolve(spec.root.style?.color))
        XCTAssertNil(dark.resolve(spec.root.style?.background))
    }

    func testAHexNeedsHexDigitsOnly() {
        XCTAssertNil(PrototypeRGBA(hex: "#+12345"))
        XCTAssertNil(PrototypeRGBA(hex: "#-1234567"))
        XCTAssertNotNil(PrototypeRGBA(hex: "#aBcDeF"))
        XCTAssertTrue(PrototypeThemeModes.isColor("#80aBcDeF"))
        XCTAssertTrue(PrototypeThemeModes.isColor("surfaceContainerHighest"))
        XCTAssertFalse(PrototypeThemeModes.isColor("#12345"))
        XCTAssertFalse(PrototypeThemeModes.isColor(""))
    }

    func testUnknownFlatThemeColourKeysAreReportedAndNotApplied() throws {
        let colors = try JSONDecoder().decode(
            PrototypeThemeColors.self,
            from: Data(
                ##"{"seed":"#6750A4","source":"seed","primary":"#112233","primry":"#445566","accent":"#778899"}"##
                    .utf8
            )
        )
        XCTAssertEqual(colors.roles, ["primary": "#112233"])
        XCTAssertEqual(colors.unknownKeys, ["accent", "primry"])
    }

    // MARK: Sheet scrim

    func testASheetScrimTapClosesTheSheet() throws {
        var session = PrototypeSession()
        try session.show(spec("""
        {"id":"s","window":{"placement":{"type":"fullscreen"}},"state":{"open":true},
         "root":{"type":"box","children":[
           {"type":"bottomSheet","openWhen":{"key":"open","equals":true},"detents":["half"],
            "scrim":{"light":"#52000000","dark":"scrim"},"child":{"type":"spacer"}}]}}
        """))
        let sheet = try XCTUnwrap(session.spec?.root.children?.first)
        try XCTAssertEqual(light.scrim(sheet.scrim), hex("#52000000"))
        XCTAssertEqual(dark.scrim(sheet.scrim), PrototypeRGBA(red: 0, green: 0, blue: 0, alpha: 0.4))
        XCTAssertEqual(session.closeModal(sheet).map(\.name), ["change"])
        XCTAssertEqual(session.state["open"], .bool(false))
    }

    // MARK: Scrim resolution

    /// Owner decision 2026-10-10: only the `scrim` role is given an alpha when it is a scrim.
    func testOnlyTheScrimRoleIsDimmedInBothScrimPositionsAndBothModes() throws {
        XCTAssertEqual(PrototypePalette.scrimRoleAlpha, 0.4)
        let spec = try spec("""
        {"id":"s","window":{"placement":{"type":"fullscreen","scrim":"scrim"}},"state":{"open":true},
         "theme":{"colors":{"light":{"scrim":"#112233"},"dark":{"scrim":"#80445566"}}},
         "root":{"type":"bottomSheet","openWhen":{"key":"open","equals":true},"detents":["half"],
                 "scrim":"scrim","child":{"type":"spacer"}}}
        """)
        var lightScrim = try hex("#112233")
        lightScrim.alpha = 0.4
        var darkScrim = try hex("#445566")
        darkScrim.alpha = 0.4
        for (systemDark, expected) in [(false, lightScrim), (true, darkScrim)] {
            let palette = PrototypePalette.make(theme: spec.theme, systemDark: systemDark)
            XCTAssertEqual(palette.scrim(spec.window.placement.scrim), expected, "placement, dark \(systemDark)")
            XCTAssertEqual(palette.scrim(spec.root.scrim), expected, "sheet, dark \(systemDark)")
        }
        // Themeless: the baseline scrim role is black in both schemes.
        let dim = PrototypeRGBA(red: 0, green: 0, blue: 0, alpha: 0.4)
        XCTAssertEqual(light.scrim("scrim"), dim)
        XCTAssertEqual(dark.scrim("scrim"), dim)
        XCTAssertNil(light.scrim(nil))
    }

    func testAnotherRoleAHexAndAMixedPairKeepTheirOwnAlphaAsAScrim() throws {
        XCTAssertEqual(light.scrim("surface"), PrototypePalette.baselineLight["surface"])
        XCTAssertEqual(dark.scrim("surface"), PrototypePalette.baselineDark["surface"])
        XCTAssertEqual(light.scrim("surface")?.alpha, 1)
        for palette in [light, dark] {
            try XCTAssertEqual(palette.scrim("#52000000"), hex("#52000000"))
            try XCTAssertEqual(palette.scrim("#000000"), hex("#000000"), "an opaque hex stays opaque")
            try XCTAssertEqual(palette.scrim("#00000000"), hex("#00000000"))
        }
        let dim = PrototypeRGBA(red: 0, green: 0, blue: 0, alpha: 0.4)
        let roleInDark = PrototypeModeValue.modes(light: "#99102030", dark: "scrim")
        try XCTAssertEqual(light.scrim(roleInDark), hex("#99102030"))
        XCTAssertEqual(dark.scrim(roleInDark), dim)
        let roleInLight = PrototypeModeValue.modes(light: "scrim", dark: "inverseSurface")
        XCTAssertEqual(light.scrim(roleInLight), dim)
        XCTAssertEqual(dark.scrim(roleInLight), PrototypePalette.baselineDark["inverseSurface"])
        // The alpha belongs to the scrim slots only: the same role elsewhere is the plain colour.
        try XCTAssertEqual(dark.resolve("scrim"), hex("#000000"))
    }
}
