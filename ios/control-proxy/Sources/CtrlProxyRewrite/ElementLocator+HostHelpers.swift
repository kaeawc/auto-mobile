import Foundation

struct KeyboardFocus {
    enum Source {
        case snapshot
        case liveQuery
    }

    let frame: CGRect
    let source: Source
}

enum KeyboardFocusDecision: Equatable {
    case skip
    case useSnapshotFrame(CGRect)
    case liveQuery
}

extension ElementLocator {
    // MARK: - Platform-independent helpers (host-compiled and host-tested)

    //
    // These operate only on `UIElementInfo` / `ElementBounds` / scalars, so they live
    // outside the `#if os(iOS)` block and are exercised directly by the parity tests on
    // macOS. On this `@MainActor` class they must be `nonisolated static` so non-isolated
    // test code (and the iOS instance methods, synchronously) can call them without hopping.

    /// Conservative reverse-DNS candidate shape for identifiers outside the legacy prefix gate.
    /// A leading ASCII letter rejects numeric/version tokens; all labels must be non-empty
    /// and contain only ASCII letters, digits or hyphens. Underscores are not bundle-ID characters.
    /// A filename such as `icon.png` is indistinguishable here from a two-label bundle ID;
    /// the caller's foreground-state probe must still confirm every candidate.
    nonisolated static func isPotentialBundleId(_ identifier: String) -> Bool {
        identifier.range(
            of: "^[A-Za-z][A-Za-z0-9-]*(\\.[A-Za-z0-9-]+)+$",
            options: .regularExpression
        ) == identifier.startIndex ..< identifier.endIndex
    }

    /// Extract a bundle-ID candidate from a SpringBoard accessibility identifier.
    /// Preserve the original cleaning and legacy accept path: its historical comments only
    /// describe a bundle-ID heuristic, without documenting which non-bundle strings it filtered.
    nonisolated static func bundleIdFromSpringboardIdentifier(_ identifier: String) -> String? {
        guard !identifier.isEmpty else { return nil }
        var cleanId = identifier

        // SpringBoard cards use `card:<bundleId>:sceneID:<sceneId>` (also `@card:`).
        if identifier.hasPrefix("@card:") {
            cleanId = String(identifier.dropFirst(6))
        } else if identifier.hasPrefix("card:") {
            cleanId = String(identifier.dropFirst(5))
        }
        if identifier.hasPrefix("@card:") || identifier.hasPrefix("card:") {
            if let colonIndex = cleanId.firstIndex(of: ":") {
                cleanId = String(cleanId[..<colonIndex])
            }
        }

        // Keep the existing replacement semantics, including repeated/embedded suffixes.
        cleanId = cleanId.replacingOccurrences(of: "-window", with: "")
            .replacingOccurrences(of: "-sceneID", with: "")
            .replacingOccurrences(of: "-SceneWindow", with: "")

        let matchesLegacyGate = cleanId.contains(".") && !cleanId.contains(" ") &&
            ["com.", "io.", "org.", "net.", "me.", "dev."].contains { cleanId.hasPrefix($0) }
        return matchesLegacyGate || isPotentialBundleId(cleanId) ? cleanId : nil
    }

    /// Resolve a snapshot frame using the offset inherited from its parent. When the
    /// candidate escapes a non-empty resolved parent but adding that parent's origin
    /// makes it fit, the node starts a local coordinate space. Return the composed
    /// offset so descendants use the same space even when they fill their local parent.
    /// Frames that already fit, or still escape after translation, stay unshifted.
    nonisolated static func screenFrame(
        _ frame: CGRect,
        enclosingFrame: CGRect?,
        coordinateOffset: CGPoint
    )
        -> (frame: CGRect, offset: CGPoint)
    {
        let candidate = frame.offsetBy(dx: coordinateOffset.x, dy: coordinateOffset.y)
        guard let enclosingFrame,
              frame.width > 0,
              frame.height > 0,
              enclosingFrame.width > 0,
              enclosingFrame.height > 0,
              !enclosingFrame.contains(candidate)
        else {
            return (candidate, coordinateOffset)
        }
        let translated = candidate.offsetBy(dx: enclosingFrame.minX, dy: enclosingFrame.minY)
        guard enclosingFrame.contains(translated) else {
            return (candidate, coordinateOffset)
        }
        return (
            translated,
            CGPoint(x: coordinateOffset.x + enclosingFrame.minX, y: coordinateOffset.y + enclosingFrame.minY)
        )
    }

    /// Treat invalid snapshot frames as zero-area so only usable descendants keep their wrappers.
    nonisolated static func hasZeroArea(_ frame: CGRect) -> Bool {
        frame.width <= 0 || frame.height <= 0 || frame.isInfinite
            || !frame.origin.x.isFinite || !frame.origin.y.isFinite
            || !frame.size.width.isFinite || !frame.size.height.isFinite
    }

    /// Keep zero-area wrappers only when their subtree contains a usable frame.
    nonisolated static func shouldKeepZeroAreaChild(hasNonZeroAreaDescendant: Bool) -> Bool {
        return hasNonZeroAreaDescendant
    }

    /// Returns the foreground match when available; otherwise consults SpringBoard.
    /// Keeping the fallback here makes all lookup paths preserve app precedence while
    /// allowing actions to resolve system-owned alerts that observation exposes (#4014).
    nonisolated static func firstMatchingElement<Element>(
        foregroundLookup: () -> Element?,
        springBoardLookup: () -> Element?
    )
        -> Element?
    {
        foregroundLookup() ?? springBoardLookup()
    }

    /// Spotlight must take precedence over SpringBoard while it owns the
    /// foreground accessibility hierarchy; other tracked apps retain their roots.
    /// `nonisolated static` (like the sibling helpers above) so the non-isolated
    /// v6 parity tests can call it synchronously on this `@MainActor` class.
    nonisolated static func preferredSystemSurfaceBundleId(
        trackedBundleId: String?,
        spotlightStateRaw: UInt
    )
        -> String?
    {
        guard trackedBundleId == "com.apple.springboard", spotlightStateRaw >= 4 else {
            return nil
        }
        return "com.apple.Spotlight"
    }

    /// Choose SpringBoard for a visible switcher before considering its app cards.
    nonisolated static func foregroundBundleId(
        from candidates: [String],
        springboardRunning: Bool,
        switcherVisible: Bool
    )
        -> String?
    {
        if springboardRunning, switcherVisible { return "com.apple.springboard" }
        return candidates.first { $0 != "com.apple.springboard" }
    }

    // MARK: - Same-Type Child Collapsing & Sibling Dedup

    /// Class name strings for text-input element types whose UIKit internal subviews
    /// produce same-type nested children in the XCUITest accessibility tree.
    /// NOTE: Must stay in sync with `textInputElementTypes` (the XCUIElement.ElementType set
    /// inside #if os(iOS)). Note that .searchField maps to "UISearchBar" (not "UISearchField").
    nonisolated static let textInputClassNames: Set<String> = [
        "UITextField",
        "UISecureTextField",
        "UITextView",
        "UISearchBar",
    ]

    /// Adds typed XCTest text-input candidates that the recursive application
    /// snapshot did not contain. Fallback nodes are leaves below the application
    /// root because XCTest does not expose a reliable parent for this path.
    nonisolated static func mergeMissingTextInputCandidates(
        into root: UIElementInfo,
        candidates: [UIElementInfo]
    )
        -> UIElementInfo
    {
        var existing = allNodes(in: root)
        var rootChildren = root.node ?? []

        for candidate in candidates {
            guard !existing.contains(where: { isSameTextInput($0, candidate) }) else {
                continue
            }

            let leaf = copying(candidate, node: nil)
            rootChildren.append(leaf)
            existing.append(leaf)
        }

        return copying(root, node: rootChildren.isEmpty ? nil : rootChildren)
    }

    private nonisolated static func allNodes(in element: UIElementInfo) -> [UIElementInfo] {
        [element] + (element.node ?? []).flatMap(allNodes)
    }

    private nonisolated static func isSameTextInput(_ lhs: UIElementInfo, _ rhs: UIElementInfo) -> Bool {
        guard lhs.resourceId == rhs.resourceId,
              lhs.className == rhs.className,
              let lhsBounds = lhs.bounds,
              let rhsBounds = rhs.bounds
        else {
            return false
        }

        return lhsBounds.left == rhsBounds.left
            && lhsBounds.top == rhsBounds.top
            && lhsBounds.right == rhsBounds.right
            && lhsBounds.bottom == rhsBounds.bottom
    }

    nonisolated static func copying(_ element: UIElementInfo, node: [UIElementInfo]?) -> UIElementInfo {
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
            node: node
        )
    }

    /// Check whether a UIElementInfo carries any unique identifying information
    /// (text, resourceId, contentDesc, hintText). Elements without these are
    /// considered internal UIKit subviews that should be collapsed/deduped.
    nonisolated static func hasUniqueIdentifyingProperties(_ element: UIElementInfo) -> Bool {
        return element.text != nil
            || element.resourceId != nil
            || element.contentDesc != nil
            || element.hintText != nil
    }

    /// Whether usable text-input snapshots justify looking for keyboard focus (issue #5474).
    ///
    /// The keyboard-focus frame is only ever applied to text-input nodes when
    /// building element info, so when the captured snapshot exposes no text-input
    /// node there is nothing a focus frame could annotate — the extra live query
    /// (a main-thread IPC round trip) is pure overhead and is skipped. With usable
    /// inputs, `keyboardFocusDecision` prefers captured focus and only queries live
    /// when the captured keyboard is visible but no input reports focus. The live
    /// lookup also requires a foreground app and an existing match before snapshotting.
    nonisolated static func shouldQueryKeyboardFocus(textInputSnapshotCount: Int) -> Bool {
        return textInputSnapshotCount > 0
    }

    /// Collect usable text-input nodes in pre-order, visiting children even when their parent is skipped.
    nonisolated static func collectTextInputNodes<Node>(
        _ root: Node,
        isTextInput: (Node) -> Bool,
        frame: (Node) -> CGRect,
        children: (Node) -> [Node]
    )
        -> [Node]
    {
        func collect(_ node: Node, into nodes: inout [Node]) {
            if isTextInput(node), !frame(node).isEmpty {
                nodes.append(node)
            }
            for child in children(node) {
                collect(child, into: &nodes)
            }
        }
        var nodes: [Node] = []
        collect(root, into: &nodes)
        return nodes
    }

    /// Detect a usable keyboard by reading the captured nodes directly, without copying the tree.
    nonisolated static func keyboardVisibleInSnapshot<Node>(
        _ snapshot: Node,
        isKeyboard: (Node) -> Bool,
        frame: (Node) -> CGRect,
        children: (Node) -> [Node]
    )
        -> Bool
    {
        if isKeyboard(snapshot), !frame(snapshot).isEmpty {
            return true
        }
        return children(snapshot).contains {
            keyboardVisibleInSnapshot($0, isKeyboard: isKeyboard, frame: frame, children: children)
        }
    }

    /// Skip when no usable input exists, reuse the first non-empty focused snapshot
    /// frame without IPC, or query live only when the captured keyboard is visible
    /// and no usable input reports focus. Otherwise rely on snapshot.hasFocus.
    /// Snapshot focus works for some fields, but iPhone UIKit may require the live
    /// keyboard-focus predicate. Reusing captured focus avoids another remote
    /// resolution that can block when the app backgrounds (issue #9082). Live lookup
    /// is gated on foreground state and a no-wait existence check before snapshotting.
    /// Evaluate captured keyboard visibility only when usable inputs lack captured focus.
    nonisolated static func keyboardFocusDecision(
        textInputCandidates: [(frame: CGRect, hasFocus: Bool)],
        keyboardVisibleInSnapshot: @autoclosure () -> Bool
    )
        -> KeyboardFocusDecision
    {
        let usableInputs = textInputCandidates.filter { !$0.frame.isEmpty }
        guard shouldQueryKeyboardFocus(textInputSnapshotCount: usableInputs.count) else {
            return .skip
        }
        if let focused = usableInputs.first(where: { $0.hasFocus }) {
            return .useSnapshotFrame(focused.frame)
        }
        return keyboardVisibleInSnapshot() ? .liveQuery : .skip
    }

    /// Live focus overrides captured focus for usable frames. Snapshot-derived focus
    /// supplements captured focus so other focused nodes retain their own state.
    nonisolated static func resolveKeyboardFocus(
        nodeFrame: CGRect,
        isTextInput: Bool,
        snapshotHasFocus: Bool,
        keyboardFocus: KeyboardFocus?
    )
        -> Bool
    {
        guard let keyboardFocus, !nodeFrame.isEmpty, !keyboardFocus.frame.isEmpty else {
            return snapshotHasFocus
        }
        let focusFrame = keyboardFocus.frame
        let epsilon: CGFloat = 0.5
        let framesMatch = abs(nodeFrame.origin.x - focusFrame.origin.x) < epsilon
            && abs(nodeFrame.origin.y - focusFrame.origin.y) < epsilon
            && abs(nodeFrame.width - focusFrame.width) < epsilon
            && abs(nodeFrame.height - focusFrame.height) < epsilon
        switch keyboardFocus.source {
        case .liveQuery:
            return framesMatch && isTextInput
        case .snapshot:
            return (framesMatch && isTextInput) || snapshotHasFocus
        }
    }

    /// Whether a second SpringBoard snapshot is required to discover system-owned
    /// windows that can overlay a still-foreground app.
    ///
    /// The app snapshot cannot prove that SpringBoard has no alert: iOS custom-URL
    /// confirmations are visible on screen while the underlying app hierarchy remains
    /// unchanged. Skip only when the foreground snapshot is already SpringBoard.
    nonisolated static func shouldSnapshotSpringboardForAlerts(
        foregroundIsSpringboard: Bool
    )
        -> Bool
    {
        return !foregroundIsSpringboard
    }

    /// Whether the last-resort ~40-app `checkSystemApps` foreground sweep should
    /// run, or be short-circuited by a recently cached negative result (issue #5474).
    ///
    /// A zero `lastMissTime` (never swept, or invalidated by a foreground switch)
    /// always runs. A clock that appears to run backwards also runs, to avoid
    /// wedging on a bad sample. Otherwise the sweep is skipped until the TTL since
    /// the last miss has elapsed.
    nonisolated static func shouldRunSystemAppSweep(
        now: UInt64,
        lastMissTime: UInt64,
        ttlNanos: UInt64
    )
        -> Bool
    {
        guard lastMissTime != 0 else { return true }
        guard now >= lastMissTime else { return true }
        return (now - lastMissTime) >= ttlNanos
    }

    /// Resolve the logical screen dimensions reported in the hierarchy.
    ///
    /// The XCUITest runner process can report a stale 320x480 `UIScreen.main.bounds`
    /// when it runs in legacy compatibility mode (issue #2683). The foreground app's
    /// root snapshot frame reflects the true device size, so prefer it and fall back
    /// to the runner-reported bounds only when the root frame is unavailable or
    /// degenerate.
    nonisolated static func resolveScreenDimensions(
        rootBounds: ElementBounds?,
        fallbackWidth: Int,
        fallbackHeight: Int,
        elements: [UIElementInfo] = []
    )
        -> (width: Int, height: Int)
    {
        if let bounds = rootBounds, bounds.width > 0, bounds.height > 0 {
            var exceedsRoot = false
            var fitsSwapped = true
            var fullLandscapeFrame = false
            func visit(_ element: UIElementInfo) {
                if let frame = element.bounds {
                    if frame.right > bounds.right || frame.bottom > bounds.bottom {
                        exceedsRoot = true
                    }
                    if frame.right > bounds.left + bounds.height ||
                        frame.bottom > bounds.top + bounds.width
                    {
                        fitsSwapped = false
                    }
                    if frame.left <= bounds.left, frame.top <= bounds.top,
                       frame.right > bounds.right, frame.bottom >= bounds.top + bounds.width
                    {
                        fullLandscapeFrame = true
                    }
                }
                for child in element.node ?? [] {
                    visit(child)
                }
            }
            for element in elements {
                visit(element)
            }
            if exceedsRoot, fitsSwapped, fullLandscapeFrame {
                return (bounds.height, bounds.width)
            }
            return (bounds.width, bounds.height)
        }
        return (fallbackWidth, fallbackHeight)
    }

    /// Compute the physical screenshot pixel dimensions for the reported point dimensions.
    ///
    /// `nativeScale` must be `UIScreen.nativeScale`, never `UIScreen.scale`: under Display
    /// Zoom the two differ (e.g. a zoomed iPhone reports scale 3.0 while nativeScale is
    /// ~3.14, and an iPhone Plus reports scale 3.0 with nativeScale ~2.61), and
    /// `XCUIScreenshot.pngRepresentation` is rendered at native scale — so only
    /// `points * nativeScale` matches the actual screenshot pixels (#4548).
    ///
    /// Returns nil when any input is degenerate, so the additive wire fields are simply
    /// omitted rather than carrying values no screenshot can match.
    nonisolated static func computePixelDimensions(
        pointWidth: Int,
        pointHeight: Int,
        nativeScale: Double
    )
        -> (pixelWidth: Int, pixelHeight: Int)?
    {
        guard pointWidth > 0, pointHeight > 0, nativeScale.isFinite, nativeScale > 0 else {
            return nil
        }
        return (
            pixelWidth: Int((Double(pointWidth) * nativeScale).rounded()),
            pixelHeight: Int((Double(pointHeight) * nativeScale).rounded())
        )
    }

    /// A leaf at the raw depth cap is complete; only withheld children make the walk partial.
    nonisolated static func depthCapTruncationReason(depth: Int, maxDepth: Int, hasChildren: Bool) -> String? {
        depth >= maxDepth && hasChildren ? "max_depth" : nil
    }
}
