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

    /// A fresh SpringBoard snapshot while another app is in front holds only the lit panel's
    /// windows, so the active-panel window-count vote has nothing to compare. A window on a
    /// non-main display is an inner-panel window laid out in portrait space; its alerts need the
    /// same rotation as the inner panel's own tree, using that window's portrait height.
    static func alertPortraitHeight(
        windowDisplayId: UInt64?, mainDisplayId: UInt64?, windowPortraitHeight: Int?
    )
        -> Int?
    {
        guard let windowDisplayId, let mainDisplayId, windowDisplayId != mainDisplayId,
              let windowPortraitHeight, windowPortraitHeight > 0 else { return nil }
        return windowPortraitHeight
    }

    /// Interface rotation of the inner panel as an app on it reports it (`rotation` 1 is 951x669).
    static let innerPanelRotation = 1
}

/// On an iPhone the SpringBoard window that hosts a system alert keeps its portrait frame while
/// the app in front of it is rotated, even though SpringBoard's root frame turns landscape: a
/// fresh SpringBoard snapshot frames the alert in portrait space while the app's own tree is
/// landscape (#18858). The alert is drawn rotated with the app, so its bounds need the same
/// quarter-turn to share the observation's space and to be tappable.
struct PortraitSpringBoardRotation: Equatable, Sendable {
    /// `DeviceRotation` value: 1 is landscapeLeft, 3 is landscapeRight.
    let rotation: Int
    let portraitWidth: Int
    let portraitHeight: Int

    /// Non-nil only when the alert's window is portrait-shaped, the app frame is its landscape
    /// transpose and the device reads landscape. A window that already matches the app (an iPad,
    /// or a portrait app) needs nothing.
    static func resolve(alertWindowFrame: CGRect, appFrame: CGRect, deviceRotation: Int?) -> Self? {
        guard deviceRotation == 1 || deviceRotation == 3, let rotation = deviceRotation else { return nil }
        let window = GestureSize(width: Double(alertWindowFrame.width), height: Double(alertWindowFrame.height))
        let app = GestureSize(width: Double(appFrame.width), height: Double(appFrame.height))
        let tolerance = 1.0
        guard window.isValid, app.isValid, window.width < window.height,
              abs(app.width - window.height) <= tolerance,
              abs(app.height - window.width) <= tolerance else { return nil }
        return Self(
            rotation: rotation,
            portraitWidth: ElementBounds.clampedInt(alertWindowFrame.width),
            portraitHeight: ElementBounds.clampedInt(alertWindowFrame.height)
        )
    }

    /// landscapeLeft puts the portrait top edge on the left, so `(x, y)` is drawn at
    /// `(y, width - x)`; landscapeRight is the opposite turn, `(height - y, x)`.
    func landscapeBounds(_ bounds: ElementBounds) -> ElementBounds {
        if rotation == 3 {
            return SpringBoardPanel.landscapeBounds(bounds, portraitHeight: portraitHeight)
        }
        return ElementBounds(
            left: bounds.top,
            top: portraitWidth - bounds.right,
            right: bounds.bottom,
            bottom: portraitWidth - bounds.left
        )
    }
}

extension ElementLocator {
    /// Dialogs and sheets are extracted from the portrait snapshot separately from the main tree, so
    /// they get the same inner-panel rotation as it. A nil height leaves app-snapshot alerts and
    /// cover-panel alerts untouched; fresh SpringBoard alerts supply their own panel height.
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
        mappingBounds(element, rootBounds: rootBounds) {
            SpringBoardPanel.landscapeBounds($0, portraitHeight: portraitHeight)
        }
    }

    /// Rotate a portrait SpringBoard alert subtree into the rotated app's landscape space (#18858).
    nonisolated static func rotatedIntoLandscape(
        _ element: UIElementInfo,
        portraitSpringBoard: PortraitSpringBoardRotation
    )
        -> UIElementInfo
    {
        mappingBounds(element, rootBounds: nil) { portraitSpringBoard.landscapeBounds($0) }
    }

    private nonisolated static func mappingBounds(
        _ element: UIElementInfo,
        rootBounds: ElementBounds?,
        _ transform: (ElementBounds) -> ElementBounds
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
            bounds: rootBounds ?? element.bounds.map(transform),
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
            node: element.node?.map { mappingBounds($0, rootBounds: nil, transform) }
        )
    }
}
