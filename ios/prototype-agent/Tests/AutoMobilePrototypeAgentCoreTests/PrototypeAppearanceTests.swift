@testable import AutoMobilePrototypeAgentCore
import XCTest

/// `prototype_appearance_v1` on iOS (#11222): the resolution order and its source, inference from
/// an authored background, the show override, the device change that re-themes, and the reports.
final class PrototypeAppearanceTests: XCTestCase {
    private func spec(root: String, theme: String? = nil, state: String = "{}") throws -> PrototypeSpec {
        let themeField = theme.map { #""theme":\#($0),"# } ?? ""
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":\(state),\(themeField)"root":\(root)}
        """.utf8))
    }

    private func box(_ background: String? = nil, extra: String = "", children: [String] = []) -> String {
        let style = background.map { #""style":{"background":\#($0)},"# } ?? ""
        return #"{"type":"box",\#(style)\#(extra)"children":[\#(children.joined(separator: ","))]}"#
    }

    private let darkHex = "\"#101010\""
    private let lightHex = "\"#FFFFFF\""
    private let plain = #"{"type":"text","text":"hi"}"#

    private func resolve(
        _ spec: PrototypeSpec,
        state: [String: JSONValue]? = nil,
        pages: [String: Int] = [:],
        override: PrototypeAppearanceOverride = .device,
        deviceDark: Bool = false
    )
        -> PrototypeAppearance
    {
        .resolve(
            theme: spec.theme,
            root: spec.root,
            state: state ?? spec.state ?? [:],
            pages: pages,
            override: override,
            deviceDark: deviceDark
        )
    }

    private func assertAppearance(
        _ appearance: PrototypeAppearance?,
        dark: Bool,
        _ source: PrototypeAppearanceSource,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(appearance?.dark, dark, file: file, line: line)
        XCTAssertEqual(appearance?.source, source, file: file, line: line)
    }

    // MARK: Capability

    func testTheAgentAdvertisesAppearance() {
        XCTAssertEqual(PrototypeAgentProtocol.appearanceCapability, "prototype_appearance_v1")
        XCTAssertEqual(PrototypeAgentProtocol.capabilities.last, "prototype_appearance_v1")
        var gate = PrototypeConnectionGate(token: "0123456789abcdef-launch-token")
        let hello = try? JSONSerialization.data(withJSONObject: [
            "type": "hello", "token": "0123456789abcdef-launch-token",
        ])
        guard case let .helloAccepted(result)? = hello.map({ gate.receive(line: $0) }) else {
            return XCTFail("hello was not accepted")
        }
        XCTAssertEqual((result["capabilities"] as? [String])?.contains("prototype_appearance_v1"), true)
    }

    // MARK: Authored-background inference

    func testADarkAuthoredBackgroundDecidesTheModeOnALightDevice() throws {
        try assertAppearance(resolve(spec(root: box(darkHex))), dark: true, .authoredBackground)
        try assertAppearance(resolve(spec(root: box(lightHex)), deviceDark: true), dark: false, .authoredBackground)
    }

    func testTheLeadingChainIsSearchedWhenTheRootPaintsNothing() throws {
        let nested = box(children: [box(children: [box(darkHex)]), box(lightHex)])
        try assertAppearance(resolve(spec(root: nested)), dark: true, .authoredBackground)
        // Only the leading chain counts: a later sibling's background is not the screen's.
        let sibling = box(children: [plain, box(darkHex)])
        try assertAppearance(resolve(spec(root: sibling)), dark: false, .system)
    }

    func testASingleChildContainerIsOnTheLeadingChain() throws {
        let scroll = #"{"type":"scroll","child":\#(box(darkHex))}"#
        try assertAppearance(resolve(spec(root: scroll)), dark: true, .authoredBackground)
    }

    func testATranslucentOrMalformedBackgroundDoesNotInfer() throws {
        try assertAppearance(resolve(spec(root: box("\"#80000000\"")), deviceDark: false), dark: false, .system)
        try assertAppearance(resolve(spec(root: box("\"#80FFFFFF\"")), deviceDark: true), dark: true, .system)
        // Alpha 0xFD is above Android's 0.99 opaque threshold, 0xFC is below it.
        try assertAppearance(resolve(spec(root: box("\"#FD000000\""))), dark: true, .authoredBackground)
        try assertAppearance(resolve(spec(root: box("\"#FC000000\""))), dark: false, .system)
        try assertAppearance(resolve(spec(root: box("\"#12\""))), dark: false, .system)
    }

    func testTheLuminanceThresholdIsAndroids() throws {
        // #757575 has luminance 0.178, #777777 0.184: either side of the 0.179 ceiling.
        try assertAppearance(resolve(spec(root: box("\"#757575\""))), dark: true, .authoredBackground)
        try assertAppearance(
            resolve(spec(root: box("\"#777777\"")), deviceDark: true),
            dark: false,
            .authoredBackground
        )
    }

    func testARoleBackgroundIsSkippedAndTheSearchContinues() throws {
        try assertAppearance(resolve(spec(root: box("\"surface\"")), deviceDark: true), dark: true, .system)
        let below = box("\"surface\"", children: [box(darkHex)])
        try assertAppearance(resolve(spec(root: below)), dark: true, .authoredBackground)
    }

    func testABackgroundPairNeverInfersAndTheSearchContinues() throws {
        // Dark on the light side: were the light value used for inference, this would read dark.
        let inverted = ##"{"light":"#000000","dark":"#FFFFFF"}"##
        let pairOnly = try spec(root: box(inverted))
        assertAppearance(resolve(pairOnly, deviceDark: false), dark: false, .system)
        assertAppearance(resolve(pairOnly, deviceDark: true), dark: true, .system)
        let hexChild = try spec(root: box(inverted, children: [box(darkHex)]))
        assertAppearance(resolve(hexChild, deviceDark: false), dark: true, .authoredBackground)
    }

    func testAHiddenNodePaintsNothingAndIsSkipped() throws {
        let hidden = #""visibleWhen":{"key":"shown","equals":true},"#
        let tree = box(children: [box(darkHex, extra: hidden), box(lightHex)])
        let closed = try spec(root: tree, state: #"{"shown":false}"#)
        assertAppearance(resolve(closed, deviceDark: true), dark: false, .authoredBackground)
        assertAppearance(resolve(closed, state: ["shown": .bool(true)]), dark: true, .authoredBackground)
        // A hidden root still leads to its children, as on Android.
        let hiddenRoot = try spec(
            root: box(lightHex, extra: hidden, children: [box(darkHex)]),
            state: #"{"shown":false}"#
        )
        assertAppearance(resolve(hiddenRoot), dark: true, .authoredBackground)
    }

    func testAStyleWhenBackgroundCountsWhileItsConditionHolds() throws {
        let night = ##""styleWhen":[{"when":{"key":"night","equals":true},"style":{"background":"#000000"}}],"##
        let tree = try spec(root: box(lightHex, extra: night), state: #"{"night":false}"#)
        assertAppearance(resolve(tree, deviceDark: true), dark: false, .authoredBackground)
        assertAppearance(resolve(tree, state: ["night": .bool(true)]), dark: true, .authoredBackground)
    }

    func testAPagerContinuesIntoItsCurrentPage() throws {
        let pager = #"{"type":"pager","id":"pg","children":[\#(box(lightHex)),\#(box(darkHex))]}"#
        let tree = try spec(root: box(children: [pager]))
        assertAppearance(resolve(tree, deviceDark: true), dark: false, .authoredBackground)
        assertAppearance(resolve(tree, pages: ["pg": 1]), dark: true, .authoredBackground)
        assertAppearance(resolve(tree, pages: ["pg": 7], deviceDark: true), dark: true, .system)
    }

    // MARK: Resolution order

    func testAnExplicitModeWinsOverEverything() throws {
        let colors = ##""colors":{"background":"#000000"}"##
        let light = try spec(root: box(darkHex), theme: #"{"mode":"light",\#(colors)}"#)
        assertAppearance(resolve(light, override: .dark, deviceDark: true), dark: false, .explicit)
        let dark = try spec(root: box(lightHex), theme: #"{"mode":"dark"}"#)
        assertAppearance(resolve(dark, override: .light, deviceDark: false), dark: true, .explicit)
    }

    func testTheOverrideStandsInForTheDeviceAndBeatsInference() throws {
        let unthemed = try spec(root: plain)
        assertAppearance(resolve(unthemed, override: .dark, deviceDark: false), dark: true, .override)
        assertAppearance(resolve(unthemed, override: .light, deviceDark: true), dark: false, .override)
        assertAppearance(resolve(unthemed, override: .device, deviceDark: true), dark: true, .system)
        // D4: the override is step 2, ahead of the role override (3) and the authored background (4).
        let roles = try spec(root: plain, theme: ##"{"colors":{"background":"#000000"}}"##)
        assertAppearance(resolve(roles, override: .light), dark: false, .override)
        try assertAppearance(resolve(spec(root: box(darkHex)), override: .light), dark: false, .override)
    }

    func testSystemModeIsTheOverrideElseTheDeviceAndNeverInfers() throws {
        let system = try spec(root: box(darkHex), theme: ##"{"mode":"system","colors":{"background":"#000000"}}"##)
        assertAppearance(resolve(system, deviceDark: false), dark: false, .system)
        assertAppearance(resolve(system, deviceDark: true), dark: true, .system)
        assertAppearance(resolve(system, override: .dark, deviceDark: false), dark: true, .override)
    }

    func testTheRoleOverrideBeatsTheAuthoredBackground() throws {
        let background = try spec(root: box(lightHex), theme: ##"{"colors":{"background":"#000000"}}"##)
        assertAppearance(resolve(background, deviceDark: false), dark: true, .roleLuminance)
        let surface = try spec(root: box(darkHex), theme: ##"{"colors":{"surface":"#FFFFFF"}}"##)
        assertAppearance(resolve(surface, deviceDark: true), dark: false, .roleLuminance)
        // `background` is read before `surface`.
        let both = try spec(root: plain, theme: ##"{"colors":{"background":"#FFFFFF","surface":"#000000"}}"##)
        assertAppearance(resolve(both, deviceDark: true), dark: false, .roleLuminance)
    }

    func testAModeMapNeverDecidesTheMode() throws {
        let maps = ##"{"colors":{"light":{"background":"#000000"},"dark":{"background":"#FFFFFF"}}}"##
        let tree = try spec(root: plain, theme: maps)
        assertAppearance(resolve(tree, deviceDark: false), dark: false, .system)
        assertAppearance(resolve(tree, deviceDark: true), dark: true, .system)
    }

    func testAThemeWithoutAModeStillInfersFromTheAuthoredBackground() throws {
        let seeded = try spec(root: box(darkHex), theme: ##"{"colors":{"seed":"#6750A4"}}"##)
        assertAppearance(resolve(seeded), dark: true, .authoredBackground)
    }

    // MARK: Override decoding

    func testTheShowAppearanceFieldParses() {
        XCTAssertEqual(PrototypeAppearanceOverride.parse(nil), .device)
        XCTAssertEqual(PrototypeAppearanceOverride.parse(NSNull()), .device)
        XCTAssertEqual(PrototypeAppearanceOverride.parse("device"), .device)
        XCTAssertEqual(PrototypeAppearanceOverride.parse("light"), .light)
        XCTAssertEqual(PrototypeAppearanceOverride.parse("dark"), .dark)
        for bad: Any in ["system", "Dark", "", 1, true, ["mode": "dark"]] {
            XCTAssertNil(PrototypeAppearanceOverride.parse(bad), "\(bad)")
        }
    }

    // MARK: One mode per show

    func testThePaletteTheChromeAndTheReportShareTheSessionsMode() throws {
        var session = PrototypeSession()
        let pair = ##"{"light":"#111111","dark":"#EEEEEE"}"##
        let root = box(darkHex, children: [#"{"type":"text","text":"hi","style":{"color":\#(pair)}}"#])
        try session.show(spec(root: root))
        let appearance = try XCTUnwrap(session.appearance)
        assertAppearance(appearance, dark: true, .authoredBackground)
        let palette = PrototypePalette.make(theme: session.spec?.theme, dark: appearance.dark)
        XCTAssertTrue(palette.dark)
        XCTAssertEqual(
            palette.resolve(PrototypeModeValue.modes(light: "#111111", dark: "#EEEEEE")),
            PrototypeRGBA(hex: "#EEEEEE")
        )
        XCTAssertEqual(palette.asset(.modes(light: "sun", dark: "moon")), "moon")
        XCTAssertEqual(palette.scrim("scrim"), PrototypeRGBA(red: 0, green: 0, blue: 0, alpha: 0.4))
        XCTAssertEqual(
            PrototypeHostChrome.dismissBarColors(palette: palette).content,
            PrototypePalette.baselineDark["onSurface"]
        )
    }

    func testAStateChangeThatFlipsInferenceFlipsTheOneModeForEverything() throws {
        var session = PrototypeSession()
        let night = ##""styleWhen":[{"when":{"key":"night","equals":true},"style":{"background":"#000000"}}],"##
        try session.show(spec(root: box(lightHex, extra: night), state: #"{"night":false}"#))
        XCTAssertEqual(session.appearance?.dark, false)
        let toggle = try JSONDecoder().decode(
            PrototypeAction.self,
            from: Data(#"{"type":"toggle","key":"night"}"#.utf8)
        )
        let events = session.run([toggle])
        // The device did not change, so the only event is the state change.
        XCTAssertEqual(events.map(\.kind), ["emit"])
        assertAppearance(session.appearance, dark: true, .authoredBackground)
    }

    // MARK: Session: override, device change, event

    func testTheSessionKeepsTheShowsOverrideAndAShowWithoutOneFollowsTheDeviceAgain() throws {
        var session = PrototypeSession()
        XCTAssertNil(session.appearance)
        try session.show(spec(root: plain), appearance: .dark)
        assertAppearance(session.appearance, dark: true, .override)
        XCTAssertEqual(session.appearance?.deviceDark, false)
        try session.show(spec(root: plain))
        assertAppearance(session.appearance, dark: false, .system)
        _ = session.dismiss(reason: .agent)
        XCTAssertNil(session.appearance)
    }

    func testADeviceChangeRethemesASystemSpecAndEmitsExactlyOneEvent() throws {
        var session = PrototypeSession()
        let pager = #"{"type":"pager","id":"pg","children":[\#(plain),\#(plain)]}"#
        try session.show(spec(root: pager, theme: #"{"mode":"system"}"#, state: #"{"count":3}"#))
        _ = session.setPage("pg", 1)
        let events = session.setDeviceDark(true)
        XCTAssertEqual(events.count, 1)
        let event = try XCTUnwrap(events.first)
        XCTAssertEqual(event.kind, "appearance_changed")
        XCTAssertNil(event.name)
        XCTAssertEqual(event.payload, .object(["mode": .string("dark"), "source": .string("system")]))
        XCTAssertEqual(event.sequence, 2)
        // State and pages are kept, and travel with the event like any other.
        XCTAssertEqual(event.state, ["count": .number(3)])
        XCTAssertEqual(event.pages, ["pg": 1])
        XCTAssertEqual(session.state, ["count": .number(3)])
        XCTAssertEqual(session.pages, ["pg": 1])
        XCTAssertEqual(session.appearance, PrototypeAppearance(dark: true, source: .system, deviceDark: true))
        // A repeated report changes nothing.
        XCTAssertEqual(session.setDeviceDark(true).count, 0)
        XCTAssertEqual(session.setDeviceDark(false).map(\.payload), [
            .object(["mode": .string("light"), "source": .string("system")]),
        ])
        XCTAssertEqual(session.lastSequence, 3)
    }

    func testADeviceChangeThatDoesNotChangeTheModeEmitsNothing() throws {
        let cases: [(PrototypeSpec, PrototypeAppearanceOverride, PrototypeAppearanceSource)] = try [
            (spec(root: plain, theme: #"{"mode":"dark"}"#), .device, .explicit),
            (spec(root: plain), .light, .override),
            (spec(root: plain, theme: #"{"mode":"system"}"#), .dark, .override),
            (spec(root: plain, theme: ##"{"colors":{"surface":"#000000"}}"##), .device, .roleLuminance),
            (spec(root: box(darkHex)), .device, .authoredBackground),
        ]
        for (shown, override, source) in cases {
            var session = PrototypeSession()
            session.show(shown, appearance: override)
            let before = session.appearance
            XCTAssertEqual(before?.source, source)
            XCTAssertEqual(session.setDeviceDark(true).count, 0, "\(source)")
            XCTAssertEqual(session.appearance?.dark, before?.dark, "\(source)")
            // The report still says what the device is set to.
            XCTAssertEqual(session.appearance?.deviceDark, true, "\(source)")
            XCTAssertEqual(session.lastSequence, 0, "\(source)")
        }
    }

    func testADeviceChangeWithNothingShownIsRememberedForTheNextShow() throws {
        var session = PrototypeSession()
        XCTAssertEqual(session.setDeviceDark(true).count, 0)
        try session.show(spec(root: plain))
        XCTAssertEqual(session.appearance, PrototypeAppearance(dark: true, source: .system, deviceDark: true))
        _ = session.dismiss(reason: .user)
        XCTAssertEqual(session.setDeviceDark(false).count, 0)
        XCTAssertTrue(session.deviceDark == false)
    }

    // MARK: Report

    func testTheReportAndTheEventPayloadUseTheWireNames() throws {
        let appearance = PrototypeAppearance(dark: true, source: .authoredBackground, deviceDark: false)
        let wire = appearance.wireObject
        XCTAssertEqual(Set(wire.keys), ["mode", "source", "deviceDark"])
        XCTAssertEqual(wire["mode"] as? String, "dark")
        XCTAssertEqual(wire["source"] as? String, "authoredBackground")
        XCTAssertEqual(wire["deviceDark"] as? Bool, false)
        XCTAssertEqual(
            appearance.eventPayload,
            .object(["mode": .string("dark"), "source": .string("authoredBackground")])
        )
        XCTAssertEqual(PrototypeAppearance(dark: false, source: .system, deviceDark: false).mode, "light")
        XCTAssertEqual(
            [PrototypeAppearanceSource.explicit, .override, .roleLuminance, .authoredBackground, .system]
                .map(\.rawValue),
            ["explicit", "override", "roleLuminance", "authoredBackground", "system"]
        )
        XCTAssertEqual([PrototypeAppearanceOverride.device, .light, .dark].map(\.rawValue), ["device", "light", "dark"])
    }

    func testTheEventIsAPrototypeEventOnTheWire() throws {
        var session = PrototypeSession()
        try session.show(spec(root: plain))
        let wire = try XCTUnwrap(session.setDeviceDark(true).first).wireObject(timestamp: 7)
        XCTAssertEqual(wire["type"] as? String, "prototype_event")
        XCTAssertEqual(wire["kind"] as? String, "appearance_changed")
        XCTAssertTrue(wire["name"] is NSNull)
        XCTAssertEqual(wire["payload"] as? [String: String], ["mode": "dark", "source": "system"])
        XCTAssertEqual(wire["id"] as? String, "p")
        XCTAssertEqual(wire["sequence"] as? Int, 1)
    }
}
