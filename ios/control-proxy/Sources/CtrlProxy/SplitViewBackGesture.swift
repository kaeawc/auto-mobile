import Foundation

/// Duo's split-view system back button has an empty label, but exposes `BackButton` in AX.
/// Its observed frame, rather than a panel-specific offset or safe-area inset, locates the tap.
enum SplitViewBackGesture {
    enum ElementKind: Hashable {
        case navigationBar, button, collectionLike, toolbar, other
    }

    struct ElementSnapshot: Equatable, Hashable {
        let kind: ElementKind
        let label: String
        let identifier: String
        let frame: CGRect

        func hash(into hasher: inout Hasher) {
            hasher.combine(kind)
            hasher.combine(label)
            hasher.combine(identifier)
            hasher.combine(frame.origin.x)
            hasher.combine(frame.origin.y)
            hasher.combine(frame.size.width)
            hasher.combine(frame.size.height)
        }

        var title: String { identifier.isEmpty ? label : identifier }
    }

    enum Decision: Equatable {
        case notSplitView
        case tapBackButton(GesturePoint)
        case nothingToGoBack
    }

    struct ScreenSignature: Equatable {
        let detailNavigationIdentifier: String?
        let elements: [ElementSnapshot: Int]
    }

    private static func isOnPanel(_ frame: CGRect, size: GestureSize) -> Bool {
        size.isValid && !frame.isEmpty && !frame.isInfinite &&
            frame.minX >= 0 && frame.minY >= 0 && frame.maxX <= size.width && frame.maxY <= size.height
    }

    private static func splitView(
        _ elements: [ElementSnapshot], size: GestureSize
    )
        -> (sidebar: ElementSnapshot, detail: ElementSnapshot)?
    {
        for sidebar in elements where sidebar.kind == .collectionLike &&
            (sidebar.label == "Sidebar" || sidebar.identifier == "Sidebar") &&
            isOnPanel(sidebar.frame, size: size) && sidebar.frame.minX <= 2 &&
            // A collapsed rail is not a visible split-view pane.
            sidebar.frame.width >= size.width * 0.2 && sidebar.frame.width < size.width / 2 &&
            sidebar.frame.height >= size.height * 0.9
        {
            let bars = elements.filter { $0.kind == .navigationBar && isOnPanel($0.frame, size: size) }
            guard let sidebarBar = bars.first(where: {
                $0.frame.minX <= 2 && $0.frame.maxX <= sidebar.frame.maxX + 2 && !$0.title.isEmpty
            }), let detailBar = bars.first(where: {
                $0.frame.width > sidebar.frame.width && !$0.title.isEmpty && $0.title != sidebarBar.title
            }) else { continue }
            return (sidebar, detailBar)
        }
        return nil
    }

    static func decision(_ elements: [ElementSnapshot], size: GestureSize) -> Decision {
        guard let split = splitView(elements, size: size) else { return .notSplitView }
        guard let button = elements.first(where: {
            $0.kind == .button && $0.identifier == "BackButton" && isOnPanel($0.frame, size: size) &&
                $0.frame.minX >= split.sidebar.frame.maxX
        }) else { return .nothingToGoBack }
        return .tapBackButton(GesturePoint(x: button.frame.midX, y: button.frame.midY))
    }

    static func screenSignature(_ elements: [ElementSnapshot], size: GestureSize) -> ScreenSignature {
        ScreenSignature(
            detailNavigationIdentifier: splitView(elements, size: size)?.detail.title,
            elements: elements.filter { $0.kind != .toolbar }.reduce(into: [:]) { counts, element in
                counts[element, default: 0] += 1
            }
        )
    }

    static func didChange(before: ScreenSignature, after: ScreenSignature) -> Bool {
        before != after
    }

    static func requireChange(before: ScreenSignature, after: ScreenSignature) throws {
        guard didChange(before: before, after: after) else {
            throw GesturePerformer.GestureError
                .backNoEffect("the detail pane did not visibly change after tapping BackButton")
        }
    }

    /// Returns false only when the caller should keep its existing single-column back route.
    static func perform(_ decision: Decision, tap: (GesturePoint) throws -> Void) throws -> Bool {
        switch decision {
        case .notSplitView:
            return false
        case .nothingToGoBack:
            throw GesturePerformer.GestureError
                .nothingToGoBack("already at the root of the detail pane; nothing to go back to")
        case let .tapBackButton(point):
            try tap(point)
            return true
        }
    }
}
