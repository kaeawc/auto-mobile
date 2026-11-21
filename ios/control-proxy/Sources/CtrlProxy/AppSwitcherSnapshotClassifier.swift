import Foundation

/// SpringBoard keeps full-screen switcher cards behind foreground apps. Only a scaled card
/// inside the switcher content is evidence that the App Switcher is actually presented.
enum AppSwitcherSnapshotClassifier {
    struct ElementSnapshot {
        let identifier: String
        let frame: CGRect
        let value: String?
    }

    /// An iPad window parked by Home (Windowed Apps) keeps a scaled card with this value (#18828).
    static let stashedCardValue = "Stashed"

    static func isVisible(_ elements: [ElementSnapshot]) -> Bool {
        let contentViews = elements.filter {
            $0.identifier == "AppSwitcherContentView" && $0.frame.width > 0 && $0.frame.height > 0
        }
        return contentViews.contains { content in
            elements.contains { card in
                card.identifier.hasPrefix("card:") && card.value != stashedCardValue
                    && card.frame.width > 0 && card.frame.height > 0
                    && card.frame.width < content.frame.width * 0.9
            }
        }
    }
}

/// SpringBoard exposes its icon list only while the home screen is the front surface. An iPad app
/// window parked by Home (Windowed Apps, Stage Manager) still reports `.runningForeground`, so the
/// icon list is the evidence that SpringBoard is in front (#18828).
enum SpringBoardHomeScreenClassifier {
    static let iconListIdentifier = "Home screen icons"

    static func isShowing(_ elements: [AppSwitcherSnapshotClassifier.ElementSnapshot]) -> Bool {
        elements.contains {
            $0.identifier == iconListIdentifier && $0.frame.width > 0 && $0.frame.height > 0
        }
    }
}
