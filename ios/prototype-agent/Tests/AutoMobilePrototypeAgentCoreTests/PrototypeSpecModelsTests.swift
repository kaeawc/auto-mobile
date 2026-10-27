@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeSpecModelsTests: XCTestCase {
    private struct Models: Decodable, Encodable {
        let offset: Offset
        let padding: Padding
        let safeAreaPadding: SafeAreaPadding
        let chartRange: PrototypeChartRange
    }

    func testFilledFixtureRoundTripsEveryField() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/models.json")
        let data = try Data(contentsOf: url)
        let models = try JSONDecoder().decode(Models.self, from: data)
        XCTAssertEqual(models.offset.x, -12.5)
        XCTAssertEqual(models.offset.y, 24.25)
        XCTAssertEqual(models.padding.top, 1.5)
        XCTAssertEqual(models.padding.bottom, 2.5)
        XCTAssertEqual(models.padding.start, 3.5)
        XCTAssertEqual(models.padding.end, 4.5)
        XCTAssertEqual(models.safeAreaPadding.edges, ["top", "start"])
        XCTAssertEqual(models.safeAreaPadding.types, ["systemBars", "ime"])
        XCTAssertEqual(models.chartRange, PrototypeChartRange(min: -2.5, max: 10.5))
        let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(models))
        guard case let .object(source) = try JSONDecoder().decode(JSONValue.self, from: data) else {
            return XCTFail("fixture is not an object")
        }
        // The fixture also carries Kotlin-only models; Swift emits only those it consumes.
        guard case let .object(round) = encoded else { return XCTFail("models did not encode") }
        for name in ["offset", "padding", "safeAreaPadding", "chartRange"] {
            XCTAssertEqual(round[name], source[name], name)
        }
    }

    func testMigratedModelsDecodeSharedFixture() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/models.json")
        let data = try Data(contentsOf: url)
        struct Migrated: Decodable {
            let placementFullscreen: Placement
            let placementSheet: Placement
            let placementFloating: Placement
            let listItemTrailingSwitch: PrototypeListItemTrailing
            let listItemTrailingCheckbox: PrototypeListItemTrailing
            let listItemTrailingIcon: PrototypeListItemTrailing
            let appBarAction: PrototypeAppBarAction
            let dialogButton: PrototypeDialogButton
            let border: Border
            let gradientStop: PrototypeGradientStop
            let gradientLinear: PrototypeGradient
            let gradientRadial: PrototypeGradient
            let item: NavItem
            let itemString: NavItem
        }
        let models = try JSONDecoder().decode(Migrated.self, from: data)
        XCTAssertEqual(models.placementFullscreen.type, "fullscreen")
        XCTAssertEqual(models.placementFullscreen.scrim, .modes(light: "#112233", dark: "#445566"))
        XCTAssertNil(models.placementFullscreen.edge)
        XCTAssertNil(models.placementFullscreen.height)
        XCTAssertNil(models.placementFullscreen.gravity)
        XCTAssertNil(models.placementFullscreen.offset)
        XCTAssertEqual(models.placementSheet.type, "sheet")
        XCTAssertEqual(models.placementSheet.edge, "bottom")
        XCTAssertEqual(models.placementSheet.height, 320)
        XCTAssertNil(models.placementSheet.scrim)
        XCTAssertEqual(models.placementFloating.type, "floating")
        XCTAssertEqual(models.placementFloating.gravity, "center")
        XCTAssertEqual(models.placementFloating.offset, Offset(x: -12.5, y: 24.25))
        XCTAssertEqual(models.listItemTrailingSwitch, .switch(stateKey: "enabled"))
        XCTAssertEqual(models.listItemTrailingCheckbox, .checkbox(stateKey: "enabled"))
        XCTAssertEqual(models.listItemTrailingIcon, .icon(name: "check"))
        XCTAssertEqual(models.appBarAction.icon, "check")
        XCTAssertEqual(models.appBarAction.label, "Go")
        XCTAssertEqual(models.appBarAction.onTap?.count, 1)
        XCTAssertEqual(models.appBarAction.onTap?.first?.type, "emit")
        XCTAssertEqual(models.appBarAction.onTap?.first?.name, "go")
        XCTAssertEqual(models.dialogButton.label, "Go")
        XCTAssertEqual(models.dialogButton.onTap?.first?.type, "emit")
        XCTAssertEqual(models.dialogButton.onTap?.first?.name, "go")
        XCTAssertEqual(models.border.width, 2.5)
        XCTAssertEqual(models.border.color, .single("#112233"))
        XCTAssertEqual(
            models.gradientStop,
            PrototypeGradientStop(color: .modes(light: "#112233", dark: "#445566"), position: 0.5)
        )
        let stops = [
            PrototypeGradientStop(color: .single("#112233"), position: 0),
            PrototypeGradientStop(color: .modes(light: "#112233", dark: "#445566"), position: 1),
        ]
        XCTAssertEqual(models.gradientLinear, .linear(angle: 45, stops: stops))
        XCTAssertEqual(models.gradientRadial, .radial(stops: stops))
        XCTAssertEqual(models.item.label, "Home")
        XCTAssertEqual(models.item.icon, "home")
        XCTAssertEqual(models.item.image, .modes(light: "home-light", dark: "home-dark"))
        XCTAssertEqual(models.itemString.label, "Search")
        XCTAssertEqual(models.itemString.icon, "search")
        XCTAssertEqual(models.itemString.image, .single("search-image"))
        guard case let .object(source) = try JSONDecoder().decode(JSONValue.self, from: data) else {
            return XCTFail("fixture is not an object")
        }
        for (name, value) in [
            ("listItemTrailingSwitch", models.listItemTrailingSwitch),
            ("listItemTrailingCheckbox", models.listItemTrailingCheckbox),
            ("listItemTrailingIcon", models.listItemTrailingIcon),
        ] {
            let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
            XCTAssertEqual(encoded, source[name])
        }
    }

    func testPlacementAndTrailingRequireKnownTagsAndRequiredVariantFields() throws {
        for json in [
            #"{"type":"unknown"}"#,
            "{}",
            #"{"type":"sheet","edge":"bottom"}"#,
            #"{"type":"floating","gravity":"center"}"#,
        ] {
            XCTAssertThrowsError(try JSONDecoder().decode(Placement.self, from: Data(json.utf8)))
        }
        for json in [#"{"type":"unknown"}"#, "{}", #"{"type":"switch"}"#] {
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeListItemTrailing.self, from: Data(json.utf8)))
        }
        let fullscreen = try JSONDecoder().decode(Placement.self, from: Data(#"{"type":"fullscreen"}"#.utf8))
        XCTAssertNil(fullscreen.scrim)
    }

    func testGradientRejectsInvalidStopCountsAndPositionsInBothVariants() throws {
        for type in ["linear", "radial"] {
            for count in [0, 1, 5] {
                let stops = Array(repeating: "{\"color\":\"#112233\"}", count: count).joined(separator: ",")
                let data = Data("{\"type\":\"\(type)\",\"angle\":45,\"stops\":[\(stops)]}".utf8)
                XCTAssertThrowsError(try JSONDecoder().decode(PrototypeGradient.self, from: data)) { error in
                    guard case let DecodingError.dataCorrupted(context) = error else {
                        return XCTFail("Expected stop-count corruption, got \(error)")
                    }
                    XCTAssertEqual(context.debugDescription, "A gradient needs 2 to 4 stops")
                    XCTAssertEqual(context.codingPath.last?.stringValue, "stops")
                }
            }
            for position in [-0.01, 1.01] {
                let data = Data("""
                {"type":"\(type)","angle":45,"stops":[
                  {"color":"#112233","position":\(position)}, {"color":"#445566"}]}
                """.utf8)
                XCTAssertThrowsError(try JSONDecoder().decode(PrototypeGradient.self, from: data)) { error in
                    guard case let DecodingError.dataCorrupted(context) = error else {
                        return XCTFail("Expected position corruption, got \(error)")
                    }
                    XCTAssertEqual(context.debugDescription, "A gradient stop position must be within 0 and 1")
                    XCTAssertEqual(context.codingPath.last?.stringValue, "stops")
                }
            }
        }
        for json in [
            #"{"type":"unknown","stops":[]}"#,
            "{\"type\":\"linear\",\"stops\":[{\"color\":\"#112233\"},{\"color\":\"#445566\"}]}",
        ] {
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeGradient.self, from: Data(json.utf8)))
        }
        let item = try JSONDecoder().decode(NavItem.self, from: Data(#"{"label":"Home"}"#.utf8))
        XCTAssertNil(item.icon)
        XCTAssertNil(item.image)
        XCTAssertThrowsError(try JSONDecoder().decode(NavItem.self, from: Data("{}".utf8)))
    }

    func testOptionalAndRequiredFieldsRetainDecodingBehavior() throws {
        for json in ["{}", #"{"top":null,"bottom":null,"start":null,"end":null}"#] {
            let padding = try JSONDecoder().decode(Padding.self, from: Data(json.utf8))
            XCTAssertNil(padding.top)
            XCTAssertNil(padding.bottom)
            XCTAssertNil(padding.start)
            XCTAssertNil(padding.end)
        }
        XCTAssertThrowsError(try JSONDecoder().decode(Offset.self, from: Data(#"{"x":1}"#.utf8)))
    }

    func testUnknownKeysStayIgnoredByLeafDecoderAndRejectedAtStrictBoundary() throws {
        let offset = #"{"x":1,"y":2,"unknown":1}"#
        let padding = #"{"top":1,"unknown":1}"#
        XCTAssertNoThrow(try JSONDecoder().decode(Offset.self, from: Data(offset.utf8)))
        XCTAssertNoThrow(try JSONDecoder().decode(Padding.self, from: Data(padding.utf8)))
        for (name, value) in [("offset", offset), ("padding", padding)] {
            let data = Data("""
            {"id":"models","window":{"placement":{"type":"fullscreen"}},
             "root":{"type":"box","children":[],"style":{"\(name)":\(value)}}}
            """.utf8)
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data)) { error in
                XCTAssertEqual(
                    error as? PrototypeLoadError,
                    .invalidSpec(path: "root.style.\(name).unknown", message: "Unknown property")
                )
            }
        }
    }
}
