import Foundation

/// Merges XCUITest-based `ViewHierarchy` with SDK's in-process `SdkViewHierarchy`,
/// populating the `extras` field on each `UIElementInfo` node with `sdk.*` keys.
///
/// If no SDK hierarchy is available, returns the XCUITest hierarchy unchanged.
public enum HierarchyMerger {

    /// Tolerance in points for bounds matching between XCUITest and SDK nodes.
    private static let boundsTolerance = 2

    /// Merge SDK hierarchy data into the XCUITest hierarchy.
    public static func merge(xcuitest: ViewHierarchy, sdk: SdkViewHierarchy?) -> ViewHierarchy {
        guard let sdkRoot = sdk?.root else { return xcuitest }
        guard let xcuitestRoot = xcuitest.hierarchy else { return xcuitest }

        // Build a flat lookup from the SDK tree keyed by (className, bounds)
        var lookup: [LookupKey: SdkViewNode] = [:]
        buildLookup(node: sdkRoot, into: &lookup)

        let enrichedRoot = enrichNode(xcuitestRoot, lookup: lookup)

        return ViewHierarchy(
            updatedAt: xcuitest.updatedAt,
            packageName: xcuitest.packageName,
            hierarchy: enrichedRoot,
            windowInfo: xcuitest.windowInfo,
            windows: xcuitest.windows,
            screenScale: xcuitest.screenScale,
            screenWidth: xcuitest.screenWidth,
            screenHeight: xcuitest.screenHeight,
            error: xcuitest.error,
            fallbackToSpringboard: xcuitest.fallbackToSpringboard
        )
    }

    // MARK: - Lookup

    private struct LookupKey: Hashable {
        let className: String
        let left: Int
        let top: Int
        let right: Int
        let bottom: Int
    }

    private static func buildLookup(node: SdkViewNode, into lookup: inout [LookupKey: SdkViewNode]) {
        // Insert exact key + all tolerance variants so findMatch is O(1)
        let tol = boundsTolerance
        for dl in -tol...tol {
            for dt in -tol...tol {
                for dr in -tol...tol {
                    for db in -tol...tol {
                        let key = LookupKey(
                            className: node.className,
                            left: node.bounds.left + dl,
                            top: node.bounds.top + dt,
                            right: node.bounds.right + dr,
                            bottom: node.bounds.bottom + db
                        )
                        if lookup[key] == nil {
                            lookup[key] = node
                        }
                    }
                }
            }
        }
        if let children = node.children {
            for child in children {
                buildLookup(node: child, into: &lookup)
            }
        }
    }

    // MARK: - Matching

    private static func findMatch(className: String?, bounds: ElementBounds?, in lookup: [LookupKey: SdkViewNode]) -> SdkViewNode? {
        guard let className = className, let bounds = bounds else { return nil }
        return lookup[LookupKey(
            className: className,
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom
        )]
    }

    // MARK: - Enrichment

    private static func enrichNode(_ element: UIElementInfo, lookup: [LookupKey: SdkViewNode]) -> UIElementInfo {
        let sdkNode = findMatch(className: element.className, bounds: element.bounds, in: lookup)
        let enrichedExtras = buildExtras(existing: element.extras, sdkNode: sdkNode)

        let enrichedChildren: [UIElementInfo]? = element.node?.map { enrichNode($0, lookup: lookup) }

        return UIElementInfo(
            text: element.text,
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
            testTag: element.testTag,
            role: element.role,
            stateDescription: element.stateDescription,
            errorMessage: element.errorMessage,
            hintText: element.hintText,
            viewId: element.viewId,
            extras: enrichedExtras,
            actions: element.actions,
            node: enrichedChildren
        )
    }

    private static func buildExtras(existing: [String: String]?, sdkNode: SdkViewNode?) -> [String: String]? {
        guard let node = sdkNode else { return existing }

        var extras = existing ?? [:]

        if !node.accessibilityTraits.isEmpty {
            extras["sdk.accessibilityTraits"] = node.accessibilityTraits.joined(separator: ",")
        }
        if !node.accessibilityCustomActions.isEmpty {
            extras["sdk.accessibilityCustomActions"] = node.accessibilityCustomActions.joined(separator: ",")
        }
        if !node.gestureRecognizers.isEmpty {
            let gestures = node.gestureRecognizers.map { "\($0.type)(\($0.isEnabled ? "enabled" : "disabled"))" }
            extras["sdk.gestureRecognizers"] = gestures.joined(separator: ",")
        }
        if let bg = node.backgroundColor {
            extras["sdk.backgroundColor"] = bg
        }
        extras["sdk.alpha"] = String(node.alpha)
        if node.cornerRadius > 0 {
            extras["sdk.cornerRadius"] = String(node.cornerRadius)
        }
        extras["sdk.isAccessibilityElement"] = String(node.isAccessibilityElement)
        if node.accessibilityElementsHidden {
            extras["sdk.accessibilityElementsHidden"] = "true"
        }
        extras["sdk.hasTapTarget"] = String(node.hasTapTarget)
        if node.isOccluded {
            extras["sdk.isOccluded"] = "true"
        }
        extras["sdk.isUserInteractionEnabled"] = String(node.isUserInteractionEnabled)

        return extras.isEmpty ? nil : extras
    }
}
