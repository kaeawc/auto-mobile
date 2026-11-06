import Foundation

/// SpringBoard on a two-panel device (iPhone Duo) puts the windows of BOTH panels in one
/// snapshot, each tagged with its display id, while the snapshot root keeps the main (cover)
/// panel's frame. Reading that snapshot as one screen serves the cover's home screen after an
/// unfold and drops the inner panel's content as off-screen (#17046).
///
/// The snapshot carries no explicit "active" flag. On iOS 27.1 the active panel hosts extra
/// per-panel overlay windows, so it owns strictly more windows than the idle one (21/18 folded,
/// 19/21 unfolded in the captured home-screen snapshots). An equal count is ambiguous and
/// selects nothing, which keeps the single-panel behavior.
enum SpringBoardPanel {
    struct Selection: Equatable, Sendable {
        let displayId: UInt64
        /// The main screen is the cover panel; every other panel is drawn rotated (see
        /// `landscapeBounds`).
        let isMainDisplay: Bool
    }

    static func select(windowDisplayIds: [UInt64], mainDisplayId: UInt64?) -> Selection? {
        let counts = Dictionary(windowDisplayIds.map { ($0, 1) }, uniquingKeysWith: +)
        guard counts.count > 1, let mainDisplayId else { return nil }
        let ranked = counts.sorted { $0.value > $1.value }
        guard ranked[0].value > ranked[1].value else { return nil }
        return Selection(displayId: ranked[0].key, isMainDisplay: ranked[0].key == mainDisplayId)
    }

    /// The inner panel's windows are laid out in the device's portrait space while the panel is
    /// shown landscape (devicectl reports landscapeRight), so an element at `(x, y)` is visible at
    /// `(height - y, x)`. `portraitHeight` is the panel window's portrait height in points.
    static func landscapeBounds(_ bounds: ElementBounds, portraitHeight: Int) -> ElementBounds {
        ElementBounds(
            left: portraitHeight - bounds.bottom,
            top: bounds.left,
            right: portraitHeight - bounds.top,
            bottom: bounds.right
        )
    }

    /// Interface rotation of the inner panel as an app on it reports it (`rotation` 1 is 951x669).
    static let innerPanelRotation = 1
}

extension ElementLocator {
    /// Dialogs and sheets are extracted from the portrait snapshot separately from the main tree, so
    /// they get the same inner-panel rotation as it. `innerPanelPortraitHeight` is nil on the cover
    /// and for every other app, which leaves them untouched.
    nonisolated static func alertsInObservedSpace(
        _ alerts: [UIElementInfo],
        innerPanelPortraitHeight: Int?
    )
        -> [UIElementInfo]
    {
        guard let portraitHeight = innerPanelPortraitHeight else { return alerts }
        return alerts.map { rotatedIntoLandscape($0, portraitHeight: portraitHeight) }
    }

    /// Rotate every bound in a subtree into the landscape space the inner panel is shown in.
    nonisolated static func rotatedIntoLandscape(
        _ element: UIElementInfo,
        portraitHeight: Int,
        rootBounds: ElementBounds? = nil
    )
        -> UIElementInfo
    {
        UIElementInfo(
            text: element.text,
            value: element.value,
            textSize: element.textSize,
            contentDesc: element.contentDesc,
            resourceId: element.resourceId,
            className: element.className,
            bounds: rootBounds ?? element.bounds.map {
                SpringBoardPanel.landscapeBounds($0, portraitHeight: portraitHeight)
            },
            clickable: element.clickable,
            enabled: element.enabled,
            focusable: element.focusable,
            focused: element.focused,
            accessibilityFocused: element.accessibilityFocused,
            scrollable: element.scrollable,
            password: element.password,
            checkable: element.checkable,
            checked: element.checked,
            selected: element.selected,
            longClickable: element.longClickable,
            semanticLinks: element.semanticLinks,
            testTag: element.testTag,
            role: element.role,
            stateDescription: element.stateDescription,
            errorMessage: element.errorMessage,
            hintText: element.hintText,
            viewId: element.viewId,
            extras: element.extras,
            actions: element.actions,
            node: element.node?.map { rotatedIntoLandscape($0, portraitHeight: portraitHeight) }
        )
    }
}
