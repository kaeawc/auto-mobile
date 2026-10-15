import Foundation
#if canImport(XCTest) && os(iOS)
    import XCTest

    @MainActor
    enum AppSwitcherDetector {
        static func isVisible(in springboard: XCUIApplication) -> Bool {
            let candidates = [
                springboard.otherElements["AppSwitcher"],
                springboard.otherElements["App Switcher"],
                springboard.otherElements["AppSwitcherContentView"],
                springboard.collectionViews["AppSwitcher"],
                springboard.scrollViews["AppSwitcher"],
            ]

            for candidate in candidates where candidate.waitForExistence(timeout: 0.2) {
                return true
            }

            let appSwitcherPredicate = NSPredicate(
                format: "identifier CONTAINS[c] %@ OR label CONTAINS[c] %@",
                "AppSwitcher",
                "App Switcher"
            )
            return springboard.descendants(matching: .any)
                .matching(appSwitcherPredicate)
                .firstMatch
                .waitForExistence(timeout: 0.5)
        }
    }
#endif
