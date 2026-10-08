@testable import AutoMobileOverlayAgentCore
import XCTest

/// The Material 3 component nodes (#10439) on iOS: shared fixtures decode into the fields the
/// renderer reads, and taps, picks and drags change state and emit events as Android's
/// `OverlayRuntime` does.
final class OverlayComponentsTests: XCTestCase {
    private func fixture(_ name: String) throws -> OverlaySpec {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/overlay-spec/valid/\(name).json")
        return try JSONDecoder().decode(OverlaySpec.self, from: Data(contentsOf: url))
    }

    private func spec(_ json: String) throws -> OverlaySpec {
        try JSONDecoder().decode(OverlaySpec.self, from: Data(json.utf8))
    }

    private func shown(_ name: String) throws -> OverlaySession {
        var session = OverlaySession()
        try session.show(fixture(name))
        return session
    }

    private func change(_ key: String, _ value: JSONValue) -> JSONValue {
        .object(["key": .string(key), "value": value])
    }

    // MARK: Decoding

    func testAppBarDialogPickersFixtureMapsEveryNode() throws {
        let nodes = try XCTUnwrap(fixture("material-app-bar-dialog-pickers").root.children)
        XCTAssertEqual(nodes.map(\.type), [
            "topAppBar", "segmentedButton", "divider", "progress", "progress", "badge", "chip", "chip",
            "iconButton", "fab", "fab", "dialog", "snackbar",
        ])
        let bar = nodes[0]
        XCTAssertEqual(bar.title, "Alarms")
        XCTAssertEqual(bar.variant, "centerAligned")
        XCTAssertEqual(bar.navigationIcon?.icon, "menu")
        XCTAssertEqual(bar.navigationIcon?.label, "Menu")
        XCTAssertEqual(bar.actions?.map(\.label), ["Settings"])
        XCTAssertEqual(bar.actions?.first?.onTap?.first?.name, "settings")
        XCTAssertEqual(nodes[1].options, [
            OverlayOption(value: "once", label: "Once"),
            OverlayOption(value: "weekdays", label: "Weekdays"),
            OverlayOption(value: "daily", label: "Daily"),
        ])
        XCTAssertEqual(nodes[3].stateKey, "upload")
        XCTAssertNil(nodes[3].variant)
        XCTAssertEqual(nodes[4].variant, "circular")
        XCTAssertEqual(nodes[5].text, "3")
        XCTAssertEqual(nodes[6].variant, "suggestion")
        XCTAssertEqual(nodes[7].variant, "input")
        XCTAssertNil(nodes[6].toggleKey, "suggestion and input chips only run onTap")
        XCTAssertNil(nodes[7].toggleKey)
        XCTAssertEqual(nodes[8].icon, "delete")
        XCTAssertEqual(nodes[8].variant, "tonal")
        XCTAssertEqual(nodes[9].label, "New alarm")
        XCTAssertEqual(nodes[10].size, "small")

        let dialog = nodes[11]
        XCTAssertEqual(dialog.openWhen, .equals(key: "editing", value: .bool(true)))
        XCTAssertEqual(dialog.icon, "alarm")
        XCTAssertEqual(dialog.title, "Edit alarm")
        XCTAssertEqual(dialog.text, "Set the time and date.")
        XCTAssertEqual(dialog.confirm?.label, "Save")
        XCTAssertEqual(dialog.dismiss?.label, "Cancel")
        let pickers = try XCTUnwrap(dialog.child?.children)
        XCTAssertEqual(pickers.map(\.type), ["timePicker", "datePicker"])
        XCTAssertEqual(pickers[0].hourKey, "hour")
        XCTAssertEqual(pickers[0].minuteKey, "minute")
        XCTAssertEqual(pickers[0].is24Hour, true)
        XCTAssertEqual(pickers[1].stateKey, "date")

        let snackbar = nodes[12]
        XCTAssertEqual(snackbar.openWhen, .equals(key: "saved", value: .bool(true)))
        XCTAssertEqual(snackbar.action?.label, "Undo")
    }

    func testSliderChipCardFixtureMapsEveryNode() throws {
        let nodes = try XCTUnwrap(fixture("material-slider-chip-card").root.children)
        XCTAssertEqual(nodes.map(\.type), ["card", "card", "card", "row"])
        XCTAssertEqual(nodes.map(\.variant), ["elevated", "outlined", nil, nil])
        let volume = try XCTUnwrap(nodes[0].children?.first)
        XCTAssertEqual(volume.min, 0)
        XCTAssertEqual(volume.max, 10)
        XCTAssertEqual(volume.step, 1)
        XCTAssertEqual(volume.label, "Volume")
        XCTAssertNil(nodes[0].children?.last?.step)
        let chips = try XCTUnwrap(nodes[3].children)
        XCTAssertEqual(chips.map(\.toggleKey), ["mon", "tue", nil])
    }

    func testSelectionControlsFixtureMapsEveryNode() throws {
        let nodes = try XCTUnwrap(fixture("selection-controls").root.children)
        XCTAssertEqual(nodes[0].options?.map(\.value), ["chime", "beep", "silent"])
        XCTAssertEqual(nodes[1].headline, "Sync")
        XCTAssertEqual(nodes[1].supporting, "Keep alarms in step across devices")
        XCTAssertEqual(nodes[1].leadingIcon, "refresh")
        XCTAssertEqual(nodes[1].trailing?.type, "switch")
        XCTAssertEqual(nodes[1].toggleKey, "sync")
        XCTAssertEqual(nodes[2].toggleKey, "wifi")
        XCTAssertEqual(nodes[3].trailing?.name, "chevron_right")
        XCTAssertNil(nodes[3].toggleKey, "a trailing icon is decorative")
        XCTAssertEqual(nodes[5].variant, "tonal")
        XCTAssertEqual(nodes[5].icon, "check")
        XCTAssertEqual(nodes[6].variant, "elevated")
    }

    func testIconControlsAreLabelledByDescriptionThenFabLabelThenIcon() throws {
        let nodes = try XCTUnwrap(fixture("material-app-bar-dialog-pickers").root.children)
        func label(_ node: OverlayNode) -> String? {
            node.accessibilityLabel(state: [:], pager: nil, tappable: true)
        }
        XCTAssertEqual(label(nodes[8]), "Delete alarm")
        XCTAssertEqual(label(nodes[9]), "New alarm")
        XCTAssertEqual(label(nodes[10]), "edit")
    }

    // MARK: Taps

    func testToggleControlsFlipTheirKeyByTag() throws {
        var controls = try shown("material-controls")
        XCTAssertEqual(try controls.simulateTap(identifier: "alarm_switch").get().map(\.payload), [
            change("enabled", .bool(false)),
        ])
        var selection = try shown("selection-controls")
        XCTAssertEqual(try selection.simulateTap(identifier: "sync_row").get().map(\.payload), [
            change("sync", .bool(false)),
        ])
        var chips = try shown("material-slider-chip-card")
        XCTAssertEqual(try chips.simulateTap(identifier: "mon_chip").get().map(\.payload), [
            change("mon", .bool(false)),
        ])
        XCTAssertEqual(try chips.simulateTap(identifier: "add_label_chip").get().map(\.name), ["addLabel"])
    }

    func testRadioOptionBindsItsValueThenRunsTheGroupActions() throws {
        var session = try shown("selection-controls")
        let events = try session.simulateTap(identifier: "sound_group.beep").get()
        XCTAssertEqual(events.map(\.name), ["change", "soundPicked"])
        XCTAssertEqual(events.first?.payload, change("sound", .string("beep")))
        XCTAssertEqual(
            try session.simulateTap(identifier: "sound_group.beep").get().map(\.name),
            ["soundPicked"],
            "re-picking the selected option emits no change but still runs onTap, as on Android"
        )
        XCTAssertEqual(session.simulateTap(identifier: "sound_group.nope").failureValue, .notFound)
    }

    func testSegmentTapBindsTheStringKey() throws {
        var session = try shown("material-app-bar-dialog-pickers")
        XCTAssertEqual(try session.simulateTap(identifier: "repeat.daily").get().map(\.payload), [
            change("repeat", .string("daily")),
        ])
        XCTAssertEqual(try session.simulateTap(identifier: "repeat.daily").get(), [])
        XCTAssertEqual(session.state["repeat"], .string("daily"))
    }

    func testAppBarPartsRunTheirOwnActions() throws {
        var session = try shown("material-app-bar-dialog-pickers")
        XCTAssertEqual(try session.simulateTap(identifier: "bar.actions.0").get().map(\.name), ["settings"])
        XCTAssertEqual(session.simulateTap(identifier: "bar.navigation").failureValue, .notTappable)
        XCTAssertEqual(session.simulateTap(identifier: "bar.actions.1").failureValue, .notFound)
        XCTAssertEqual(session.simulateTap(identifier: "bar.actions.x").failureValue, .notFound)
    }

    func testDialogOpensThenConfirmClosesItBeforeRunningItsActions() throws {
        var session = try shown("material-app-bar-dialog-pickers")
        let root = try XCTUnwrap(session.spec?.root)
        XCTAssertEqual(session.simulateTap(identifier: "edit.confirm").failureValue, .notFound, "closed")
        XCTAssertEqual(root.openModals(state: session.state, pages: session.pages).map(\.type), [])

        let fab = try XCTUnwrap(root.children?[9])
        XCTAssertEqual(session.activate(.node(fab))?.map(\.payload), [change("editing", .bool(true))])
        XCTAssertEqual(root.openModals(state: session.state, pages: session.pages).map(\.type), ["dialog"])

        let events = try session.simulateTap(identifier: "edit.confirm").get()
        XCTAssertEqual(events.map(\.payload), [change("editing", .bool(false)), change("saved", .bool(true))])
        XCTAssertEqual(root.openModals(state: session.state, pages: session.pages).map(\.type), ["snackbar"])
    }

    func testDialogDismissAndScrimCloseWithoutTheConfirmActions() throws {
        var session = OverlaySession()
        try session.show(spec("""
        {"id":"d","window":{"placement":{"type":"fullscreen"}},"state":{"open":true},
         "root":{"type":"column","children":[
           {"type":"dialog","testTag":"d","openWhen":{"key":"open","equals":true},"title":"T",
            "confirm":{"label":"OK","onTap":[{"type":"emit","name":"ok"}]},
            "dismiss":{"label":"No","onTap":[{"type":"emit","name":"no"}]}}]}}
        """))
        XCTAssertEqual(try session.simulateTap(identifier: "d.dismiss").get().map(\.name), ["change", "no"])
        XCTAssertEqual(session.state["open"], .bool(false))
        XCTAssertEqual(session.simulateTap(identifier: "d.dismiss").failureValue, .notFound)

        _ = session.change(key: "open", value: .bool(true))
        let dialog = try XCTUnwrap(session.spec?.root.children?.first)
        XCTAssertEqual(session.closeModal(dialog).map(\.payload), [change("open", .bool(false))])
        XCTAssertEqual(session.closeModal(dialog), [], "an already-closed dialog writes nothing")
    }

    func testSnackbarActionClosesItThenRuns() throws {
        var session = OverlaySession()
        try session.show(spec("""
        {"id":"s","window":{"placement":{"type":"fullscreen"}},"state":{"shown":false},
         "root":{"type":"snackbar","testTag":"s","openWhen":{"key":"shown","equals":false},"text":"Saved",
          "action":{"label":"Undo","onTap":[{"type":"emit","name":"undo"}]}}}
        """))
        let events = try session.simulateTap(identifier: "s.action").get()
        XCTAssertEqual(events.map(\.name), ["change", "undo"])
        XCTAssertEqual(session.state["shown"], .bool(true), "closing writes the opposite of equals")
        XCTAssertEqual(session.simulateTap(identifier: "s.confirm").failureValue, .notFound)
    }

    func testOpenModalsSkipHiddenSubtreesAndOtherPages() throws {
        let root = try spec("""
        {"id":"m","window":{"placement":{"type":"fullscreen"}},"state":{"a":true,"hide":true},
         "root":{"type":"column","children":[
           {"type":"column","visibleWhen":{"key":"hide","equals":false},"children":[
             {"type":"snackbar","id":"hidden","openWhen":{"key":"a","equals":true},"text":"x"}]},
           {"type":"pager","id":"p","children":[
             {"type":"snackbar","id":"page0","openWhen":{"key":"a","equals":true},"text":"x"},
             {"type":"snackbar","id":"page1","openWhen":{"key":"a","equals":true},"text":"x"}]},
           {"type":"dialog","id":"outer","openWhen":{"key":"a","equals":true},"confirm":{"label":"OK"},
            "child":{"type":"snackbar","id":"inner","openWhen":{"key":"a","equals":true},"text":"x"}}]}}
        """).root
        let state: [String: JSONValue] = ["a": .bool(true), "hide": .bool(true)]
        XCTAssertEqual(root.openModals(state: state, pages: ["p": 1]).map(\.id), ["page1", "outer", "inner"])
        XCTAssertEqual(root.openModals(state: state, pages: [:]).map(\.id), ["page0", "outer", "inner"])
    }

    // MARK: Pickers and sliders

    func testTimeChangeStoresBothKeysInOneEvent() throws {
        var session = try shown("material-app-bar-dialog-pickers")
        let both = session.setTime(hourKey: "hour", minuteKey: "minute", hour: 8, minute: 15, then: [])
        XCTAssertEqual(both.map(\.payload), [.object([
            "keys": .array([.string("hour"), .string("minute")]),
            "values": .object(["hour": .number(8), "minute": .number(15)]),
        ])])
        let one = session.setTime(hourKey: "hour", minuteKey: "minute", hour: 9, minute: 15, then: [])
        XCTAssertEqual(one.map(\.payload), [change("hour", .number(9))])
        XCTAssertEqual(session.setTime(hourKey: "hour", minuteKey: "minute", hour: 9, minute: 15, then: []), [])
        XCTAssertEqual(
            session.setTime(hourKey: "hour", minuteKey: "date", hour: 1, minute: 1, then: []),
            [],
            "a non-numeric key leaves the picker inert"
        )
    }

    func testDatePickBindsTheStringKeyAndIgnoresNonStrings() throws {
        var session = try shown("material-app-bar-dialog-pickers")
        XCTAssertEqual(
            session.choose(key: "date", value: "2026-12-25", then: []).map(\.payload),
            [change("date", .string("2026-12-25"))]
        )
        XCTAssertEqual(session.choose(key: "hour", value: "x", then: []), [])
    }

    func testSlideStoresChangedNumbersThenRunsActions() throws {
        var session = try shown("material-slider-chip-card")
        let emit = try JSONDecoder().decode(OverlayAction.self, from: Data(#"{"type":"emit","name":"moved"}"#.utf8))
        XCTAssertEqual(session.slide(key: "volume", value: 3, then: [emit]).map(\.name), ["change", "moved"])
        XCTAssertEqual(session.slide(key: "volume", value: 3, then: [emit]), [], "an unchanged value does nothing")
        XCTAssertEqual(session.slide(key: "mon", value: 1, then: []), [], "a non-number key is inert")
    }

    func testSliderSnapsLikeAndroid() {
        XCTAssertEqual(snapOverlaySlider(3.4, min: 0, max: 10, step: 1), 3)
        XCTAssertEqual(snapOverlaySlider(3.5, min: 0, max: 10, step: 1), 4, "halves round up")
        XCTAssertEqual(snapOverlaySlider(-2, min: 0, max: 10, step: 1), 0)
        XCTAssertEqual(snapOverlaySlider(12, min: 0, max: 10, step: 2.5), 10)
        XCTAssertEqual(snapOverlaySlider(0.30000000004, min: 0, max: 1, step: 0.1), 0.3)
        XCTAssertEqual(snapOverlaySlider(7.25, min: 5, max: 30, step: nil), 7.25)
    }

    func testProgressFractionIsClampedOverMax() {
        XCTAssertEqual(overlayProgressFraction(0.4, max: nil), 0.4)
        XCTAssertEqual(overlayProgressFraction(30, max: 60), 0.5)
        XCTAssertEqual(overlayProgressFraction(2, max: nil), 1)
        XCTAssertEqual(overlayProgressFraction(-1, max: nil), 0)
        XCTAssertEqual(overlayProgressFraction(1, max: 0), 0)
    }

    func testDatesRoundTripAsUTCDaysAndRejectImpossibleOnes() throws {
        let date = try XCTUnwrap(OverlayDate.date(from: "2026-10-08"))
        XCTAssertEqual(OverlayDate.string(from: date), "2026-10-08")
        XCTAssertEqual(date.timeIntervalSince1970.truncatingRemainder(dividingBy: 86400), 0, "UTC midnight")
        for invalid in ["2026-02-30", "2026-13-01", "26-10-08", "2026-1-08", "2026-10-08T00", "", "abcd-ef-gh"] {
            XCTAssertNil(OverlayDate.date(from: invalid), invalid)
        }
        XCTAssertEqual(OverlayDate.string(from: OverlayDate.range.lowerBound), "1900-01-01")
        XCTAssertEqual(OverlayDate.string(from: OverlayDate.range.upperBound), "2100-12-31")
    }

    func testTimesRoundTripAndLabelIn24HourForm() {
        let picked = OverlayTime.components(of: OverlayTime.date(hour: 7, minute: 30))
        XCTAssertEqual(picked.hour, 7)
        XCTAssertEqual(picked.minute, 30)
        XCTAssertEqual(OverlayTime.label(hour: 7, minute: 30), "07:30")
        XCTAssertEqual(OverlayTime.label(hour: 23, minute: 5), "23:05")
    }
}

extension Result {
    fileprivate var failureValue: Failure? {
        if case let .failure(error) = self { return error }
        return nil
    }
}
