import Foundation

/// SpringBoard keeps full-screen switcher cards behind foreground apps. Only a scaled card
/// inside the switcher content is evidence that the App Switcher is actually presented.
enum AppSwitcherSnapshotClassifier {
    struct ElementSnapshot {
        let identifier: String
        let frame: CGRect
        let value: String?
    }

    static func isVisible(_ elements: [ElementSnapshot]) -> Bool {
        let contentViews = elements.filter {
            $0.identifier == "AppSwitcherContentView" && $0.frame.width > 0 && $0.frame.height > 0
        }
        return contentViews.contains { content in
            elements.contains { card in
                card.identifier.hasPrefix("card:") && card.frame.width > 0 && card.frame.height > 0
                    && card.frame.width < content.frame.width * 0.9
            }
        }
    }
}
