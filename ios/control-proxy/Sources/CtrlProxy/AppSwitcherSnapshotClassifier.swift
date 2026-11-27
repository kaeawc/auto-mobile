import Foundation

/// SpringBoard keeps full-screen switcher cards behind foreground apps. Only a scaled card
/// inside the switcher content is evidence that the App Switcher is actually presented.
enum AppSwitcherSnapshotClassifier {
    struct ElementSnapshot {
        let identifier: String
        let frame: CGRect
        let value: String?
        let label: String?

        init(identifier: String, frame: CGRect, value: String?, label: String? = nil) {
            self.identifier = identifier
            self.frame = frame
            self.value = value
            self.label = label
        }
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


/// Stage Manager shows the iPad's other app windows as cards in a strip beside the stage.
/// SpringBoard names each card `card:<bundleId>:sceneID:<scene>` with the app name as its label;
/// a strip app is suspended, so it has no live window to snapshot (#18830).
enum StageManagerStrip {
    struct Card {
        let bundleId: String
        let label: String
        let frame: ElementBounds
    }

    private static let cardPrefix = "card:"
    private static let sceneMarker = ":sceneID:"

    /// The bundle id in a SpringBoard card identifier, or nil for any other identifier.
    static func bundleId(fromCardIdentifier identifier: String) -> String? {
        guard identifier.hasPrefix(cardPrefix),
              let marker = identifier.range(of: sceneMarker) else { return nil }
        let bundleId = identifier[identifier.index(identifier.startIndex, offsetBy: cardPrefix.count) ..< marker.lowerBound]
        return bundleId.isEmpty ? nil : String(bundleId)
    }

    /// Strip cards on screen beside the focused window, top to bottom. A card is skipped when its
    /// app already has a window (`excluding`, or `isLive`: a live window is reported from its own
    /// snapshot), when Home parked it, or when it lies inside the focused window.
    static func cards(
        in elements: [AppSwitcherSnapshotClassifier.ElementSnapshot],
        excluding: Set<String>,
        focused: ElementBounds,
        screen: ElementBounds,
        isLive: (String) -> Bool
    )
        -> [Card]
    {
        var seen = Set<String>()
        let cards = elements.compactMap { element -> Card? in
            guard let bundleId = bundleId(fromCardIdentifier: element.identifier),
                  !excluding.contains(bundleId),
                  element.value != AppSwitcherSnapshotClassifier.stashedCardValue,
                  element.frame.width > 0, element.frame.height > 0,
                  seen.insert(element.identifier).inserted else { return nil }
            let frame = ElementBounds(clamping: element.frame)
            guard ElementLocator.isVisibleBesideFocused(frame, focused: focused, screen: screen),
                  !ElementLocator.overlaps(frame, focused) else { return nil }
            let label = element.label.flatMap { $0.isEmpty ? nil : $0 } ?? bundleId
            return Card(bundleId: bundleId, label: label, frame: frame)
        }
        return cards
            .filter { !isLive($0.bundleId) }
            .sorted { ($0.frame.top, $0.frame.left) < ($1.frame.top, $1.frame.left) }
    }

    /// A strip card as a one-node window: tapping it brings that app to the stage.
    static func window(for card: Card) -> VisibleAppWindow {
        VisibleAppWindow(
            bundleId: card.bundleId,
            frame: card.frame,
            hierarchy: UIElementInfo(
                text: card.label,
                resourceId: cardResourceId,
                className: cardClassName,
                bounds: card.frame,
                clickable: "true",
                role: "button"
            )
        )
    }

    static let cardResourceId = "stage-manager-strip-card"
    static let cardClassName = "StageManagerStripCard"
}
