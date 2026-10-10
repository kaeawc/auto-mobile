@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Host chrome and dialog accessibility found by the iOS visual check (#10439): the fullscreen
/// dismiss bar reserves its own space like Android's, an open dialog lists every part as its own
/// element, opening or closing a dialog drops stray keyboard focus, and icon-only controls take
/// Android's label priority.
final class PrototypeHostChromeTests: XCTestCase {
    private func fixture(_ name: String) throws -> PrototypeSpec {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid/\(name).json")
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
    }

    private func node(_ json: String) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
    }

    private func openModals(_ session: PrototypeSession) -> [PrototypeNode] {
        session.spec?.root.openModals(state: session.state, pages: session.pages) ?? []
    }

    // MARK: Dismiss bar (D2)

    func testFullscreenReservesABarOnlyAsTallAsTheControlBelowTheTopInset() {
        let chrome = PrototypeHostChrome(placementType: "fullscreen")
        XCTAssertTrue(chrome.reservesDismissBar)
        XCTAssertEqual(chrome.dismissBarHeight(safeTop: 62), 62 + 44)
        XCTAssertEqual(chrome.contentSafeTop(safeTop: 62), 0, "the bar already clears the status bar")
    }

    func testFloatingAndSheetKeepTheChipAndTheirTopInset() {
        for type in ["floating", "sheet"] {
            let chrome = PrototypeHostChrome(placementType: type)
            XCTAssertFalse(chrome.reservesDismissBar, type)
            XCTAssertEqual(chrome.dismissBarHeight(safeTop: 62), 0, type)
            XCTAssertEqual(chrome.contentSafeTop(safeTop: 62), 62, type)
        }
    }

    func testDismissBarAndChipUseSurfaceContainerHighOverOnSurfaceInBothModes() {
        for dark in [false, true] {
            let palette = PrototypePalette.make(theme: nil, systemDark: dark)
            XCTAssertEqual(palette.dark, dark)
            let bar = PrototypeHostChrome.dismissBarColors(palette: palette)
            var high = palette.chromeRole("surfaceContainerHigh")
            high.alpha = PrototypeHostChrome.dismissBarAlpha
            XCTAssertEqual(bar.background, high)
            XCTAssertEqual(bar.content, palette.chromeRole("onSurface"))
            XCTAssertLessThan(bar.background.alpha, 1)
            let chip = PrototypeHostChrome.closeChipColors(palette: palette)
            XCTAssertEqual(chip.fill, palette.chromeRole("surfaceContainerHigh"))
            XCTAssertEqual(chip.glyph, palette.chromeRole("onSurface"))
            XCTAssertGreaterThan(abs(chip.fill.luminance - chip.glyph.luminance), 0.3, "dark=\(dark)")
        }
    }

    func testDarkChipIsNotTheOldWhiteOnBlackTranslucentFixedPair() {
        let chip = PrototypeHostChrome.closeChipColors(palette: .make(theme: nil, systemDark: true))
        XCTAssertLessThan(chip.fill.luminance, 0.2)
        XCTAssertGreaterThan(chip.glyph.luminance, 0.5)
    }

    func testChromeFollowsExplicitRoleOverrides() throws {
        let theme = try JSONDecoder().decode(
            PrototypeTheme.self,
            from: Data(##"{"mode":"dark","colors":{"surfaceContainerHigh":"#102030","onSurface":"#F0E0D0"}}"##.utf8)
        )
        let palette = PrototypePalette.make(theme: theme, systemDark: false)
        XCTAssertEqual(PrototypeHostChrome.closeChipColors(palette: palette).fill, PrototypeRGBA(hex: "#102030"))
        XCTAssertEqual(PrototypeHostChrome.dismissBarColors(palette: palette).content, PrototypeRGBA(hex: "#F0E0D0"))
    }

    func testFallbackRolesAreThemedAndNilForAnUnthemedSpec() throws {
        let plain = PrototypePalette.make(theme: nil, systemDark: true)
        for role in [
            plain.sheetSurface,
            plain.sheetHandle,
            plain.navSelected,
            plain.navIndicator,
            plain.navUnselected,
            plain.placeholderFill,
            plain.placeholderGlyph,
        ] {
            XCTAssertNil(role, "unthemed specs keep the system colours")
        }
        let theme = try JSONDecoder().decode(PrototypeTheme.self, from: Data(#"{"mode":"dark"}"#.utf8))
        let palette = PrototypePalette.make(theme: theme, systemDark: false)
        XCTAssertEqual(palette.sheetSurface, palette.color(role: "surface"))
        XCTAssertEqual(palette.sheetHandle, palette.color(role: "onSurfaceVariant"))
        XCTAssertEqual(palette.navSelected, palette.color(role: "onSecondaryContainer"))
        XCTAssertEqual(palette.navIndicator, palette.color(role: "secondaryContainer"))
        XCTAssertEqual(palette.navUnselected, palette.color(role: "onSurfaceVariant"))
        XCTAssertEqual(palette.placeholderFill, palette.color(role: "surfaceVariant"))
        XCTAssertEqual(palette.placeholderGlyph, palette.color(role: "onSurfaceVariant"))
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
        var session = PrototypeSession()
        try session.show(fixture("material-app-bar-dialog-pickers"))
        let closed = openModals(session)
        let fab = try XCTUnwrap(session.spec?.root.children?[9])
        _ = session.activate(.node(fab))
        let open = openModals(session)
        XCTAssertEqual(open.map(\.title), ["Edit alarm"])
        XCTAssertTrue(prototypeModalChangeEndsEditing(from: closed.dialogIdentities, to: open))
        XCTAssertTrue(prototypeModalChangeEndsEditing(from: open.dialogIdentities, to: closed))
        XCTAssertFalse(prototypeModalChangeEndsEditing(from: open.dialogIdentities, to: open), "no change")
    }

    func testOpeningADialogWithATextFieldKeepsFocus() throws {
        let dialog = try node(#"""
        {"type":"dialog","title":"Rename","confirm":{"label":"OK"},
         "child":{"type":"column","children":[{"type":"textField","stateKey":"name"}]}}
        """#)
        XCTAssertTrue(dialog.containsTextField)
        XCTAssertFalse(prototypeModalChangeEndsEditing(from: [], to: [dialog]))
    }

    func testSnackbarsNeverChangeFocus() throws {
        let snackbar = try node(#"{"type":"snackbar","text":"Saved"}"#)
        XCTAssertFalse(prototypeModalChangeEndsEditing(from: [], to: [snackbar]))
    }

    // MARK: Icon-only labels (D4)

    func testIconOnlyControlsFollowAndroidLabelPriority() throws {
        func label(_ json: String) throws -> String? {
            try node(json).accessibilityLabel(state: [:], pager: nil, tappable: false)
        }
        // Android's prototypeContentDescription: contentDescription, then the FAB label (its text),
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
