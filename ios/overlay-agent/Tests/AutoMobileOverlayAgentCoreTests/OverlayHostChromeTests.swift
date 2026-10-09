@testable import AutoMobileOverlayAgentCore
import XCTest

/// Host chrome and dialog accessibility found by the iOS visual check (#10439): the fullscreen
/// dismiss bar reserves its own space like Android's, an open dialog lists every part as its own
/// element, opening or closing a dialog drops stray keyboard focus, and icon-only controls take
/// Android's label priority.
final class OverlayHostChromeTests: XCTestCase {
    private func fixture(_ name: String) throws -> OverlaySpec {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/overlay-spec/valid/\(name).json")
        return try JSONDecoder().decode(OverlaySpec.self, from: Data(contentsOf: url))
    }

    private func node(_ json: String) throws -> OverlayNode {
        try JSONDecoder().decode(OverlayNode.self, from: Data(json.utf8))
    }

    private func openModals(_ session: OverlaySession) -> [OverlayNode] {
        session.spec?.root.openModals(state: session.state, pages: session.pages) ?? []
    }

    // MARK: Dismiss bar (D2)

    func testFullscreenReservesABarOnlyAsTallAsTheControlBelowTheTopInset() {
        let chrome = OverlayHostChrome(placementType: "fullscreen")
        XCTAssertTrue(chrome.reservesDismissBar)
        XCTAssertEqual(chrome.dismissBarHeight(safeTop: 62), 62 + 44)
        XCTAssertEqual(chrome.contentSafeTop(safeTop: 62), 0, "the bar already clears the status bar")
    }

    func testFloatingAndSheetKeepTheChipAndTheirTopInset() {
        for type in ["floating", "sheet"] {
            let chrome = OverlayHostChrome(placementType: type)
            XCTAssertFalse(chrome.reservesDismissBar, type)
            XCTAssertEqual(chrome.dismissBarHeight(safeTop: 62), 0, type)
            XCTAssertEqual(chrome.contentSafeTop(safeTop: 62), 62, type)
        }
    }

    func testDismissBarColorsMatchAndroidsTranslucentThemedBar() {
        let light = OverlayHostChrome.dismissBarColors(dark: false)
        XCTAssertEqual(light.background, OverlayRGBA(red: 1, green: 1, blue: 1, alpha: 0x99 / 255))
        XCTAssertEqual(light.content, OverlayRGBA(rgb: 0x1A1A1A))
        let dark = OverlayHostChrome.dismissBarColors(dark: true)
        XCTAssertEqual(dark.background, OverlayRGBA(red: 0, green: 0, blue: 0, alpha: 0x99 / 255))
        XCTAssertEqual(dark.content, OverlayRGBA(rgb: 0xE6E6E6))
    }

    // MARK: Dialog parts (D3)

    func testOpenDialogListsTitleTextPickersAndBothButtons() throws {
        let dialog = try XCTUnwrap(fixture("material-app-bar-dialog-pickers").root.children?[11])
        XCTAssertEqual(dialog.dialogParts(title: "Edit alarm", text: "Set the time and date."), [
            .title("Edit alarm"),
            .text("Set the time and date."),
            .content,
            .button(part: "dismiss", label: "Cancel", identifier: "edit.dismiss"),
            .button(part: "confirm", label: "Save", identifier: "edit.confirm"),
        ])
        XCTAssertEqual(dialog.child?.children?.map(\.type), ["timePicker", "datePicker"])
    }

    func testDialogWithoutTitleTextOrChildListsOnlyItsButtons() throws {
        let dialog = try node(#"{"type":"dialog","confirm":{"label":"OK"}}"#)
        XCTAssertEqual(dialog.dialogParts(title: "", text: nil), [
            .button(part: "confirm", label: "OK", identifier: nil),
        ])
    }

    // MARK: Keyboard focus (D3)

    func testOpeningOrClosingAPickerDialogEndsEditing() throws {
        var session = OverlaySession()
        try session.show(fixture("material-app-bar-dialog-pickers"))
        let closed = openModals(session)
        let fab = try XCTUnwrap(session.spec?.root.children?[9])
        _ = session.activate(.node(fab))
        let open = openModals(session)
        XCTAssertEqual(open.map(\.title), ["Edit alarm"])
        XCTAssertTrue(overlayModalChangeEndsEditing(from: closed.dialogIdentities, to: open))
        XCTAssertTrue(overlayModalChangeEndsEditing(from: open.dialogIdentities, to: closed))
        XCTAssertFalse(overlayModalChangeEndsEditing(from: open.dialogIdentities, to: open), "no change")
    }

    func testOpeningADialogWithATextFieldKeepsFocus() throws {
        let dialog = try node(#"""
        {"type":"dialog","title":"Rename","confirm":{"label":"OK"},
         "child":{"type":"column","children":[{"type":"textField","stateKey":"name"}]}}
        """#)
        XCTAssertTrue(dialog.containsTextField)
        XCTAssertFalse(overlayModalChangeEndsEditing(from: [], to: [dialog]))
    }

    func testSnackbarsNeverChangeFocus() throws {
        let snackbar = try node(#"{"type":"snackbar","text":"Saved"}"#)
        XCTAssertFalse(overlayModalChangeEndsEditing(from: [], to: [snackbar]))
    }

    // MARK: Icon-only labels (D4)

    func testIconOnlyControlsFollowAndroidLabelPriority() throws {
        func label(_ json: String) throws -> String? {
            try node(json).accessibilityLabel(state: [:], pager: nil, tappable: false)
        }
        // Android's overlayContentDescription: contentDescription, then the FAB label (its text),
        // then the raw icon name for iconButton/fab — not humanized on either platform.
        XCTAssertEqual(
            try label(#"{"type":"fab","icon":"edit","label":"Edit","contentDescription":"Edit alarm"}"#),
            "Edit alarm"
        )
        XCTAssertEqual(try label(#"{"type":"fab","icon":"edit","label":"Edit"}"#), "Edit")
        XCTAssertEqual(try label(#"{"type":"fab","icon":"edit","size":"small"}"#), "edit")
        XCTAssertEqual(try label(#"{"type":"iconButton","icon":"shopping_cart"}"#), "shopping_cart")
    }
}
