import Foundation
#if canImport(XCTest) && os(iOS)
    import XCTest

    @MainActor
    enum AppSwitcherDetector {
        static func isVisible(in springboard: XCUIApplication) -> Bool {
            let predicate = NSPredicate(
                format: "identifier == %@ OR identifier BEGINSWITH %@",
                "AppSwitcherContentView",
                "card:"
            )
            let snapshots = springboard.descendants(matching: .any).matching(predicate)
                .allElementsBoundByIndex.filter { $0.exists }.map {
                    AppSwitcherSnapshotClassifier.ElementSnapshot(
                        identifier: $0.identifier, frame: $0.frame, value: $0.value as? String
                    )
                }
            return AppSwitcherSnapshotClassifier.isVisible(snapshots)
        }
    }
#endif
