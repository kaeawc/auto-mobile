import CoreGraphics
import Foundation
#if canImport(XCTest) && os(iOS)
    import UIKit
    import XCTest
#endif

/// A visible iPadOS app window other than the focused one, in screen space (#18830).
struct VisibleAppWindow {
    let bundleId: String
    let frame: ElementBounds
    let hierarchy: UIElementInfo
}

/// Window frames from the last observation, for moving focus to a tapped background window.
struct ObservedWindowFrames {
    let focused: ElementBounds
    let background: [(bundleId: String, frame: ElementBounds)]
}

/// Geometry from the last observation that a later gesture may reuse. Anything that can change
/// the foreground app or its windows drops all of it, so a tap never acts on a stale layout.
struct ObservedLayout {
    var gesture: ObservedGestureGeometry?
    /// Window frames from the last multi-window observation (#18830).
    var windowFrames: ObservedWindowFrames?

    mutating func invalidate() {
        gesture = nil
        windowFrames = nil
    }

    /// A launch, terminate or home: window frames are stale even when the app stays the same.
    mutating func foregroundSwitched(appChanged: Bool) {
        if appChanged {
            gesture = nil
        }
        windowFrames = nil
    }

    /// The background app a delivered tap landed in, which iPadOS just focused; the frames are
    /// consumed so a second tap cannot switch again on them.
    mutating func takeTappedBackgroundOwner(x: Double, y: Double) -> String? {
        guard let frames = windowFrames,
              let bundleId = ElementLocator.backgroundWindowOwner(x: x, y: y, in: frames) else { return nil }
        windowFrames = nil
        return bundleId
    }
}

extension ElementLocator {
    /// Apps that may own another visible window: the apps this runner has launched or observed,
    /// plus, now and then, the common system apps. SpringBoard's tree names no app windows on
    /// iOS 27.2, so it is not a source. Sorted for a
    /// stable window order; never the focused app or SpringBoard.
    nonisolated static func otherWindowCandidates(observed: Set<String>, focusedBundleId: String) -> [String] {
        observed.subtracting([focusedBundleId, "com.apple.springboard"]).sorted()
    }

    /// Whether a window is on screen and not wholly behind the focused window, which is in front.
    nonisolated static func isVisibleBesideFocused(
        _ frame: ElementBounds,
        focused: ElementBounds,
        screen: ElementBounds
    )
        -> Bool
    {
        guard frame.right > frame.left, frame.bottom > frame.top else { return false }
        let onScreen = frame.left < screen.right && frame.right > screen.left
            && frame.top < screen.bottom && frame.bottom > screen.top
        return onScreen && !contains(focused, frame)
    }

    /// Drop nodes of a background window whose centre the focused window covers, so a tap at the
    /// reported centre cannot land on the focused window instead. A covered container survives
    /// when it still holds a visible child; the window root always survives.
    nonisolated static func removingOccluded(
        _ element: UIElementInfo,
        by occluder: ElementBounds,
        isRoot: Bool = true
    )
        -> UIElementInfo?
    {
        let children = (element.node ?? []).compactMap { removingOccluded($0, by: occluder, isRoot: false) }
        let covered = element.bounds.map { contains(occluder, x: $0.centerX, y: $0.centerY) } ?? false
        if !isRoot, covered, children.isEmpty { return nil }
        return withChildren(element, children.isEmpty ? nil : children)
    }

    /// Bundle id of the app owning a merged background window root, read by
    /// src/features/observe/ios/iosWindowLayer.ts so per-app screen identity can drop it.
    nonisolated static let iosWindowPackageExtra = "automobile:iosWindowPackage"

    /// Put background windows under the focused app's root, before its own children so they
    /// read as lower in z-order, the way Android's unified hierarchy lists window roots.
    ///
    /// Each background root is stamped with its owner and an `iosWindowLayer` behind every
    /// focused layer, so host ranking never puts a background window above the focused app
    /// (an unstamped root would rank topmost). A background app's own window stamps shift by
    /// the same base, keeping its internal front-to-back order.
    nonisolated static func mergingBackgroundWindows(
        _ windows: [VisibleAppWindow],
        into root: UIElementInfo
    )
        -> UIElementInfo
    {
        guard !windows.isEmpty else { return root }
        var base = layerCount(of: root.node ?? [])
        let stamped = windows.map { window -> UIElementInfo in
            let shift = base
            let children = window.hierarchy.node.map { nodes in
                nodes.map { child -> UIElementInfo in
                    guard let layer = windowLayer(of: child) else { return child }
                    var extras = child.extras ?? [:]
                    extras[iosWindowLayerExtra] = String(shift + layer)
                    return copying(child, node: child.node, extras: extras)
                }
            }
            var extras = window.hierarchy.extras ?? [:]
            extras[iosWindowLayerExtra] = String(shift)
            extras[iosWindowPackageExtra] = window.bundleId
            base += layerCount(of: window.hierarchy.node ?? [])
            return copying(window.hierarchy, node: children, extras: extras)
        }
        return withChildren(root, stamped + (root.node ?? []))
    }

    /// Window layers stamped on a root's children; an unstamped tree is one layer.
    private nonisolated static func layerCount(of children: [UIElementInfo]) -> Int {
        (children.compactMap(windowLayer(of:)).max() ?? 0) + 1
    }

    private nonisolated static func windowLayer(of element: UIElementInfo) -> Int? {
        element.extras?[iosWindowLayerExtra].flatMap { Int($0) }
    }

    /// `windows` for an observation: the focused window first, then each background window.
    nonisolated static func windowInfos(focused: WindowInfo, background: [VisibleAppWindow]) -> [WindowInfo] {
        [focused] + background.enumerated().map { index, window in
            WindowInfo(
                id: index + 1,
                type: focused.type,
                isActive: false,
                isFocused: false,
                bounds: window.frame,
                packageName: window.bundleId
            )
        }
    }

    /// The background app whose window a screen point lands in, or nil when the point is in the
    /// focused window or outside every observed window. iPadOS focuses the window a tap lands in.
    nonisolated static func backgroundWindowOwner(x: Double, y: Double, in frames: ObservedWindowFrames) -> String? {
        guard x.isFinite, y.isFinite else { return nil }
        let px = ElementBounds.clampedInt(x)
        let py = ElementBounds.clampedInt(y)
        guard !contains(frames.focused, x: px, y: py) else { return nil }
        return frames.background.first { contains($0.frame, x: px, y: py) }?.bundleId
    }

    nonisolated static func withChildren(_ element: UIElementInfo, _ children: [UIElementInfo]?) -> UIElementInfo {
        UIElementInfo(
            text: element.text,
            value: element.value,
            textSize: element.textSize,
            contentDesc: element.contentDesc,
            resourceId: element.resourceId,
            className: element.className,
            bounds: element.bounds,
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
            node: children
        )
    }

    private nonisolated static func contains(_ outer: ElementBounds, _ inner: ElementBounds) -> Bool {
        inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom
    }

    private nonisolated static func contains(_ bounds: ElementBounds, x: Int, y: Int) -> Bool {
        x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom
    }

    #if canImport(XCTest) && os(iOS)
        /// Other running-foreground app windows on an iPad showing an inset focused window, built
        /// like the focused tree and moved into screen space (#18830). Each costs one state query,
        /// one snapshot and one window-frame read, and runs only when the focused window is inset.
        func backgroundAppWindows(
            focusedBundleId: String,
            focusedFrame: ElementBounds,
            screenFrame: CGRect,
            truncationReasons: inout Set<String>,
            disableAllFiltering: Bool
        )
            -> [VisibleAppWindow]
        {
            let screen = ElementBounds(clamping: screenFrame)
            // Apps opened outside the runner, or before it restarted, are not observed yet: sweep
            // the common system apps at most once per TTL and remember the ones found running.
            let now = DispatchTime.now().uptimeNanoseconds
            let sweep = Self.shouldRunSystemAppSweep(
                now: now, lastMissTime: tracker.lastBackgroundWindowSweep, ttlNanos: Self.backgroundWindowSweepTtlNanos
            )
            if sweep { tracker.lastBackgroundWindowSweep = now }
            let candidates = Self.otherWindowCandidates(
                observed: sweep ? tracker.observedBundleIds.union(Self.commonSystemApps) : tracker.observedBundleIds,
                focusedBundleId: focusedBundleId
            )
            var windows: [VisibleAppWindow] = []
            for bundleId in candidates {
                let app = XCUIApplication.withoutUIInterruptions(bundleIdentifier: bundleId)
                let snapshot: XCUIElementSnapshot? = catchingObjCExceptionNonThrowing({
                    guard app.state.rawValue >= 4 else { return nil } // .runningForeground only
                    return try? app.snapshot()
                }, fallback: nil)
                guard let snapshot else { continue }
                tracker.trackObserved(bundleId)
                let translation = Self.windowScreenTranslation(
                    appFrame: snapshot.frame,
                    screenFrame: screenFrame,
                    windowFrame: {
                        catchingObjCExceptionNonThrowing({ app.windows.firstMatch.frame }, fallback: nil)
                    }
                )
                let frame = ElementBounds(clamping: translation.map {
                    snapshot.frame.offsetBy(dx: $0.x, dy: $0.y)
                } ?? snapshot.frame)
                guard Self.isVisibleBesideFocused(frame, focused: focusedFrame, screen: screen) else { continue }
                let built = buildElementInfoFromSnapshot(
                    snapshot,
                    depth: 0,
                    screenBounds: snapshot.frame,
                    truncationReasons: &truncationReasons,
                    parentPath: bundleId,
                    disableAllFiltering: disableAllFiltering
                )
                let inScreen = translation.map { Self.translatedToScreen(built, by: $0) } ?? built
                let optimized = disableAllFiltering
                    ? inScreen
                    : optimizeHierarchy(inScreen, isRoot: true).first ?? inScreen
                guard let visible = Self.removingOccluded(optimized, by: focusedFrame) else { continue }
                windows.append(VisibleAppWindow(bundleId: bundleId, frame: frame, hierarchy: visible))
            }
            return windows
        }

        /// TTL for the background-window system-app sweep: about 40 state queries, so not per observe.
        private static let backgroundWindowSweepTtlNanos: UInt64 = 10_000_000_000

        /// After a tap, track the background app whose observed window the tap landed in, since
        /// iPadOS focused it; both apps stay `.runningForeground`, so state cannot tell.
        func noteTap(x: Double, y: Double) {
            guard let bundleId = layout.takeTappedBackgroundOwner(x: x, y: y) else { return }
            switchForegroundApp(bundleId: bundleId)
        }
    #endif
}
