@testable import CtrlProxy
import Foundation
import XCTest

final class AppSwitcherSnapshotClassifierTests: XCTestCase {
    private func snapshots(_ name: String) throws -> [AppSwitcherSnapshotClassifier.ElementSnapshot] {
        let url = try XCTUnwrap(Bundle.module.url(
            forResource: name, withExtension: "txt", subdirectory: "Fixtures/recent-apps"
        ))
        let dump = try String(contentsOf: url, encoding: .utf8)
        // XCUIApplication.debugDescription is captured text, not an owned structured schema.
        let pattern =
            #"\{\{([-\d.]+), ([-\d.]+)\}, \{([-\d.]+), ([-\d.]+)\}\}.*identifier: '([^']+)'(?:, label: '[^']*')?(?:, value: (.*))?"#
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
                value: group(6)
            )
        }
    }

    func testCapturedForegroundAppsAreNotTheSwitcher() throws {
        for name in ["ios26_5-safari-foreground-no-switcher", "ios27_0-safari-foreground-no-switcher"] {
            let elements = try snapshots(name)
            XCTAssertTrue(elements.contains { $0.identifier == "AppSwitcherContentView" })
            XCTAssertTrue(elements.contains { $0.identifier.hasPrefix("card:") })
            XCTAssertFalse(AppSwitcherSnapshotClassifier.isVisible(elements), name)
        }
    }

    func testCapturedOpenSwitchersAreVisible() throws {
        for name in ["ios26_5-safari-switcher-open", "ios27_0-safari-switcher-open"] {
            let elements = try snapshots(name)
            XCTAssertTrue(elements.contains { $0.identifier.hasPrefix("card:") && $0.value == "Active" })
            XCTAssertTrue(AppSwitcherSnapshotClassifier.isVisible(elements), name)
        }
    }

    func testCapturedHomeScreenIsNotTheSwitcher() throws {
        XCTAssertFalse(try AppSwitcherSnapshotClassifier.isVisible(snapshots("ios27_0-home-screen-no-switcher")))
    }

    func testEmptyAndScaledCardWithoutContentViewAreNotVisible() throws {
        XCTAssertFalse(AppSwitcherSnapshotClassifier.isVisible([]))
        let cards = try snapshots("ios27_0-safari-switcher-open").filter { $0.identifier.hasPrefix("card:") }
        XCTAssertFalse(cards.isEmpty)
        XCTAssertFalse(AppSwitcherSnapshotClassifier.isVisible(cards))
    }

    func testActiveValueAloneCannotVerifyAFullScreenCard() throws {
        let elements = try snapshots("ios27_0-safari-foreground-no-switcher").map {
            AppSwitcherSnapshotClassifier.ElementSnapshot(identifier: $0.identifier, frame: $0.frame, value: "Active")
        }
        XCTAssertFalse(AppSwitcherSnapshotClassifier.isVisible(elements))
    }
}
