@testable import CtrlProxy
import Foundation
import XCTest

/// #18830: Stage Manager's strip lists the other app windows as SpringBoard cards. Fixtures are
/// SpringBoard's debugDescription on the iPad Pro 13-inch (M5) simulator, iOS 27.2, screen
/// 1032x1376, with Settings, Files and Reminders open.
final class StageManagerStripTests: XCTestCase {
    private let screen = ElementBounds(left: 0, top: 0, right: 1032, bottom: 1376)
    /// Focused windows as observe reported them in each capture.
    private let remindersWindow = ElementBounds(left: 225, top: 154, right: 807, bottom: 1108)
    private let filesWindow = ElementBounds(left: 205, top: 104, right: 827, bottom: 1158)

    private func elements(_ name: String) throws -> [AppSwitcherSnapshotClassifier.ElementSnapshot] {
        let url = try XCTUnwrap(Bundle.module.url(
            forResource: name, withExtension: "txt", subdirectory: "Fixtures/recent-apps"
        ))
        let dump = try String(contentsOf: url, encoding: .utf8)
        // XCUIApplication.debugDescription is captured text, not an owned structured schema.
        let pattern =
            #"\{\{([-\d.]+), ([-\d.]+)\}, \{([-\d.]+), ([-\d.]+)\}\}.*identifier: '([^']+)'(?:, label: '([^']*)')?(?:, value: (.*))?"#
        let regex = try NSRegularExpression(pattern: pattern)
        return try dump.split(separator: "\n").compactMap { line in
            let text = String(line)
            guard let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else {
                return nil
            }
            func group(_ index: Int) -> String? {
                guard let range = Range(match.range(at: index), in: text) else { return nil }
                return String(text[range])
            }
            let numbers = try (1 ... 4).map { try XCTUnwrap(Double(XCTUnwrap(group($0)))) }
            return try AppSwitcherSnapshotClassifier.ElementSnapshot(
                identifier: XCTUnwrap(group(5)),
                frame: CGRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3]),
                value: group(7),
                label: group(6)
            )
        }
    }

    private func cards(
        _ name: String,
        focusedBundleId: String,
        focused: ElementBounds,
        live: Set<String> = []
    ) throws
        -> [StageManagerStrip.Card]
    {
        try StageManagerStrip.cards(
            in: elements(name),
            excluding: [focusedBundleId],
            focused: focused,
            screen: screen,
            isLive: { live.contains($0) }
        )
    }

    private func describe(_ cards: [StageManagerStrip.Card]) -> [String] {
        cards.map { card in
            let frame = card.frame
            return "\(card.bundleId) \(card.label) [\(frame.left),\(frame.top),\(frame.right),\(frame.bottom)]"
        }
    }

    func testBundleIdComesFromACardIdentifierOnly() {
        XCTAssertEqual(
            StageManagerStrip.bundleId(
                fromCardIdentifier: "card:com.apple.Preferences:sceneID:com.apple.Preferences-default"
            ),
            "com.apple.Preferences"
        )
        XCTAssertNil(StageManagerStrip.bundleId(fromCardIdentifier: "AppSwitcherContentView"))
        XCTAssertNil(StageManagerStrip.bundleId(fromCardIdentifier: "card:com.apple.Preferences"))
        XCTAssertNil(StageManagerStrip.bundleId(fromCardIdentifier: "card::sceneID:x"))
        XCTAssertNil(StageManagerStrip.bundleId(fromCardIdentifier: "card:sceneID:x"))
    }

    func testStripCardsBesideTheFocusedWindowAreReportedTopToBottom() throws {
        XCTAssertEqual(
            try describe(cards(
                "ios27_2-ipad-stage-manager-reminders-focused",
                focusedBundleId: "com.apple.reminders",
                focused: remindersWindow
            )),
            [
                "com.apple.Preferences Settings [18,420,103,613]",
                "com.apple.DocumentsApp Files [18,652,103,840]",
            ]
        )
        XCTAssertEqual(
            try describe(cards(
                "ios27_2-ipad-stage-manager-files-focused",
                focusedBundleId: "com.apple.DocumentsApp",
                focused: filesWindow
            )),
            [
                "com.apple.Preferences Settings [18,438,103,630]",
                "com.apple.reminders Reminders [18,670,75,822]",
            ]
        )
    }

    /// The focused app's own card has the focused window's frame and is never a strip card, even
    /// when the caller does not exclude it.
    func testTheFocusedWindowsOwnCardIsNotAStripCard() throws {
        let found = try StageManagerStrip.cards(
            in: elements("ios27_2-ipad-stage-manager-reminders-focused"),
            excluding: [],
            focused: remindersWindow,
            screen: screen,
            isLive: { _ in false }
        )
        XCTAssertFalse(found.contains { $0.bundleId == "com.apple.reminders" })
    }

    /// An app with a live window, or one already reported from its own snapshot, is not a card.
    func testAppsWithAWindowAreNotStripCards() throws {
        XCTAssertEqual(
            try describe(cards(
                "ios27_2-ipad-stage-manager-reminders-focused",
                focusedBundleId: "com.apple.reminders",
                focused: remindersWindow,
                live: ["com.apple.Preferences"]
            )),
            ["com.apple.DocumentsApp Files [18,652,103,840]"]
        )
        let excluded = try StageManagerStrip.cards(
            in: elements("ios27_2-ipad-stage-manager-reminders-focused"),
            excluding: ["com.apple.reminders", "com.apple.DocumentsApp", "com.apple.Preferences"],
            focused: remindersWindow,
            screen: screen,
            isLive: { _ in false }
        )
        XCTAssertTrue(excluded.isEmpty)
    }

    /// Windowed Apps (no Stage Manager): the floating window's own card is the only card, and a
    /// window Home parked is stashed, so neither is a strip card.
    func testWindowedAppsCapturesHaveNoStripCards() throws {
        let floating = ElementBounds(left: 84, top: -135, right: 950, bottom: 1066)
        let landscape = ElementBounds(left: 0, top: 0, right: 1376, bottom: 1032)
        for name in ["ios27_2-ipad-windowed-files-floating-focused", "ios27_2-ipad-windowed-files-parked-after-home"] {
            let found = try StageManagerStrip.cards(
                in: elements(name),
                excluding: ["com.apple.Preferences"],
                focused: floating,
                screen: landscape,
                isLive: { _ in false }
            )
            XCTAssertEqual(describe(found), [], name)
        }
    }

    func testAStripCardBecomesAOneNodeTappableWindow() throws {
        let card = try XCTUnwrap(cards(
            "ios27_2-ipad-stage-manager-reminders-focused",
            focusedBundleId: "com.apple.reminders",
            focused: remindersWindow
        ).first)
        let window = StageManagerStrip.window(for: card)
        XCTAssertEqual(window.bundleId, "com.apple.Preferences")
        XCTAssertEqual(window.hierarchy.text, "Settings")
        XCTAssertEqual(window.hierarchy.clickable, "true")
        XCTAssertEqual(window.hierarchy.resourceId, StageManagerStrip.cardResourceId)
        XCTAssertNil(window.hierarchy.node)
        let merged = ElementLocator.mergingBackgroundWindows(
            [window],
            into: UIElementInfo(text: "Reminders", bounds: screen, node: [UIElementInfo(text: "Reminders")])
        )
        XCTAssertEqual(merged.node?.first?.extras?[ElementLocator.iosWindowPackageExtra], "com.apple.Preferences")
        XCTAssertEqual(
            ElementLocator.windowInfos(
                focused: WindowInfo(
                    id: 0, type: 1, isActive: true, isFocused: true, bounds: remindersWindow,
                    packageName: "com.apple.reminders"
                ),
                background: [window]
            ).map { "\($0.id ?? -1) \($0.packageName ?? "") \($0.isFocused)" },
            ["0 com.apple.reminders true", "1 com.apple.Preferences false"]
        )
    }
}
