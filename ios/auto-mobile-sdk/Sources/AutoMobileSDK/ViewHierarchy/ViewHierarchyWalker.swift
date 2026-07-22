#if canImport(UIKit) && !os(watchOS)
import UIKit

/// Walks the live UIView hierarchy in-process, extracting rich properties
/// not available through XCUITest's accessibility service.
///
/// Must be called on the main thread (UIView access requirement).
/// Patterns borrowed from Slack's AccessibilityAuditor.
public enum ViewHierarchyWalker {

    // MARK: - Configuration

    private static let maxDepth = 30

    // MARK: - Public API

    /// Walk the entire view hierarchy and return a snapshot.
    /// Must be called on the main thread.
    public static func walk(bundleId: String? = nil) -> SdkViewHierarchy {
        let scale = Float(UIScreen.main.scale)
        let screenBounds = UIScreen.main.bounds
        let screenWidth = Int(screenBounds.width)
        let screenHeight = Int(screenBounds.height)

        let keyWindow = visibleKeyWindow()
        let rootNode = keyWindow.flatMap(walkWindow)
        let safeAreaInsets = keyWindow.map {
            SdkEdgeInsets(
                top: Double($0.safeAreaInsets.top),
                right: Double($0.safeAreaInsets.right),
                bottom: Double($0.safeAreaInsets.bottom),
                left: Double($0.safeAreaInsets.left)
            )
        }

        return SdkViewHierarchy(
            bundleId: bundleId,
            screenScale: scale,
            screenWidth: screenWidth,
            screenHeight: screenHeight,
            safeAreaInsets: safeAreaInsets,
            root: rootNode
        )
    }

    /// Compute a structural hash of a hierarchy for change detection.
    /// Ignores bounds (which change during animations) to focus on content changes.
    public static func computeHash(_ hierarchy: SdkViewHierarchy) -> Int {
        var hasher = Hasher()
        if let bundleId = hierarchy.bundleId {
            hasher.combine(bundleId)
        }
        if let root = hierarchy.root {
            hashNode(root, into: &hasher, depth: 0)
        }
        return hasher.finalize()
    }

    // MARK: - Window Enumeration

    private static func visibleKeyWindow() -> UIWindow? {
        let windows: [UIWindow]
        if #available(iOS 15.0, *) {
            windows = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
        } else {
            windows = UIApplication.shared.windows
        }

        // Find topmost visible window: prefer key window, then highest window level
        return windows
            .filter({ !$0.isHidden && $0.alpha > 0 })
            .max(by: { a, b in
                if a.windowLevel != b.windowLevel { return a.windowLevel < b.windowLevel }
                return !a.isKeyWindow && b.isKeyWindow
            })
    }

    private static func walkWindow(_ keyWindow: UIWindow) -> SdkViewNode? {
        var opaqueOverlays: [CGRect] = []
        let rootBounds = keyWindow.bounds

        return walkView(
            keyWindow,
            rootView: keyWindow,
            rootBounds: rootBounds,
            depth: 0,
            opaqueOverlays: &opaqueOverlays
        )
    }

    // MARK: - Recursive View Walk

    private static func walkView(
        _ view: UIView,
        rootView: UIView,
        rootBounds: CGRect,
        depth: Int,
        opaqueOverlays: inout [CGRect]
    ) -> SdkViewNode? {
        guard depth < maxDepth else { return nil }
        guard !view.isHidden, view.alpha > 0 else { return nil }

        let frameInRoot = frameInRootView(for: view, rootView: rootView)
        guard frameInRoot.width > 0, frameInRoot.height > 0 else { return nil }
        guard rootBounds.intersects(frameInRoot) else { return nil }

        let occluded = isOccludedByOpaqueOverlay(frameInRoot, overlays: opaqueOverlays)

        let className = String(describing: type(of: view))

        let bounds = sdkBounds(from: frameInRoot)
        let traits = traitNames(for: view.accessibilityTraits)
        let customActions = (view.accessibilityCustomActions ?? []).map(\.name)
        let gestures = (view.gestureRecognizers ?? []).map { gr in
            SdkGestureInfo(
                type: String(describing: type(of: gr)),
                isEnabled: gr.isEnabled
            )
        }
        let hasTap = hasOwnInteractiveAction(view)
        let bgColor = hexColor(view.backgroundColor) ?? hexColor(view.layer.backgroundColor.flatMap { UIColor(cgColor: $0) })
        let borderColor = view.layer.borderWidth > 0 ? hexColor(view.layer.borderColor.flatMap { UIColor(cgColor: $0) }) : nil
        let borderWidth = sanitizeFloat(Float(view.layer.borderWidth))

        // Walk children front-to-back for opaque overlay tracking.
        // Always use UIView.subviews — accessibilityElements may contain
        // non-UIView objects (e.g. SwiftUI accessibility nodes) that would
        // cause us to miss the real view subtree.
        let subviews = view.subviews
        var childNodes: [SdkViewNode] = []
        var childOpaqueOverlays = opaqueOverlays

        for child in subviews.reversed() {
            let childFrame = frameInRootView(for: child, rootView: rootView)
            if isOccludedByOpaqueOverlay(childFrame, overlays: childOpaqueOverlays) {
                continue
            }
            if let childNode = walkView(
                child,
                rootView: rootView,
                rootBounds: rootBounds,
                depth: depth + 1,
                opaqueOverlays: &childOpaqueOverlays
            ) {
                childNodes.append(childNode)
            }
            if isOpaqueOverlay(child) {
                childOpaqueOverlays.append(childFrame)
            }
        }
        // Reverse back to natural subview order for output
        childNodes.reverse()

        // Walk layer-only sublayers (SwiftUI shapes render as CALayer without backing UIView).
        // Exclude layers that belong to subviews since those are already represented as SdkViewNodes.
        let subviewLayerIds = Set(subviews.map { ObjectIdentifier($0.layer) })
        if let sublayers = view.layer.sublayers {
            for sublayer in sublayers {
                if subviewLayerIds.contains(ObjectIdentifier(sublayer)) { continue }
                if let layerNode = walkLayer(
                    sublayer,
                    hostLayer: view.layer,
                    rootView: rootView,
                    rootBounds: rootBounds,
                    depth: depth + 1
                ) {
                    childNodes.append(layerNode)
                }
            }
        }

        // Propagate any new opaque overlays discovered in children
        opaqueOverlays = childOpaqueOverlays

        return SdkViewNode(
            className: className,
            bounds: bounds,
            accessibilityLabel: view.accessibilityLabel,
            accessibilityIdentifier: view.accessibilityIdentifier,
            isAccessibilityElement: view.isAccessibilityElement,
            // Only readable in-process: the out-of-process runner cannot query the
            // VoiceOver cursor, so the SDK captures it here (#3924).
            isAccessibilityFocused: view.accessibilityElementIsFocused(),
            accessibilityElementsHidden: view.accessibilityElementsHidden,
            accessibilityTraits: traits,
            accessibilityCustomActions: customActions,
            gestureRecognizers: gestures,
            alpha: sanitizeFloat(Float(view.alpha)),
            backgroundColor: bgColor,
            cornerRadius: sanitizeFloat(Float(view.layer.cornerRadius)),
            borderColor: borderColor,
            borderWidth: borderWidth,
            isLayerNode: false,
            isHidden: view.isHidden,
            isUserInteractionEnabled: view.isUserInteractionEnabled,
            hasTapTarget: hasTap,
            isOccluded: occluded,
            children: childNodes.isEmpty ? nil : childNodes
        )
    }

    // MARK: - Recursive Layer Walk

    /// Walk a CALayer that has no backing UIView (e.g. SwiftUI shape rendering).
    /// Emits a synthetic SdkViewNode describing the layer's visual properties.
    private static func walkLayer(
        _ layer: CALayer,
        hostLayer: CALayer,
        rootView: UIView,
        rootBounds: CGRect,
        depth: Int
    ) -> SdkViewNode? {
        guard depth < maxDepth else { return nil }
        guard !layer.isHidden, layer.opacity > 0 else { return nil }

        // Convert layer frame to root-view coordinates.
        // layer.frame is expressed in its superlayer's coordinate space.
        let frameInRoot: CGRect
        if let superlayer = layer.superlayer {
            let converted = superlayer.convert(layer.frame, to: rootView.layer)
            frameInRoot = CGRect(
                x: converted.origin.x.rounded(),
                y: converted.origin.y.rounded(),
                width: converted.size.width.rounded(),
                height: converted.size.height.rounded()
            )
        } else {
            frameInRoot = layer.frame
        }

        guard frameInRoot.width > 0, frameInRoot.height > 0 else { return nil }
        guard rootBounds.intersects(frameInRoot) else { return nil }

        let hasAnyVisual = layer.backgroundColor != nil
            || layer.cornerRadius > 0
            || layer.borderWidth > 0
            || layer is CAShapeLayer
            || layer is CAGradientLayer

        // Recurse into sublayers first so we can decide whether to emit this node
        var childNodes: [SdkViewNode] = []
        if let sublayers = layer.sublayers {
            for sub in sublayers {
                if let childNode = walkLayer(
                    sub,
                    hostLayer: hostLayer,
                    rootView: rootView,
                    rootBounds: rootBounds,
                    depth: depth + 1
                ) {
                    childNodes.append(childNode)
                }
            }
        }

        // Skip purely structural layer nodes with no visual properties and no interesting children.
        guard hasAnyVisual || !childNodes.isEmpty else { return nil }

        let bgColor = hexColor(layer.backgroundColor.flatMap { UIColor(cgColor: $0) })
        let borderColor = layer.borderWidth > 0 ? hexColor(layer.borderColor.flatMap { UIColor(cgColor: $0) }) : nil

        return SdkViewNode(
            className: String(describing: type(of: layer)),
            bounds: sdkBounds(from: frameInRoot),
            accessibilityLabel: nil,
            accessibilityIdentifier: layer.name,
            isAccessibilityElement: false,
            accessibilityElementsHidden: false,
            accessibilityTraits: [],
            accessibilityCustomActions: [],
            gestureRecognizers: [],
            alpha: sanitizeFloat(layer.opacity),
            backgroundColor: bgColor,
            cornerRadius: sanitizeFloat(Float(layer.cornerRadius)),
            borderColor: borderColor,
            borderWidth: sanitizeFloat(Float(layer.borderWidth)),
            isLayerNode: true,
            isHidden: layer.isHidden,
            isUserInteractionEnabled: false,
            hasTapTarget: false,
            isOccluded: false,
            children: childNodes.isEmpty ? nil : childNodes
        )
    }

    // MARK: - Coordinate Conversion

    private static func frameInRootView(for view: UIView, rootView: UIView) -> CGRect {
        let frame = view.convert(view.bounds, to: rootView)
        return CGRect(
            x: frame.origin.x.rounded(),
            y: frame.origin.y.rounded(),
            width: frame.size.width.rounded(),
            height: frame.size.height.rounded()
        )
    }

    private static func sdkBounds(from rect: CGRect) -> SdkBounds {
        SdkBounds(
            left: Int(rect.origin.x),
            top: Int(rect.origin.y),
            right: Int(rect.origin.x + rect.width),
            bottom: Int(rect.origin.y + rect.height)
        )
    }

    // MARK: - Opaque Overlay Detection

    private static func isOccludedByOpaqueOverlay(_ frame: CGRect, overlays: [CGRect]) -> Bool {
        let area = frame.width * frame.height
        guard area > 0 else { return false }
        return overlays.contains { overlay in
            let intersection = overlay.intersection(frame)
            guard !intersection.isNull else { return false }
            let intersectionArea = intersection.width * intersection.height
            return intersectionArea / area >= 0.9
        }
    }

    private static func isOpaqueOverlay(_ view: UIView) -> Bool {
        guard !view.isHidden, view.alpha == 1.0 else { return false }
        if let bg = view.backgroundColor, isOpaque(bg) { return true }
        if let layerBg = view.layer.backgroundColor, isOpaque(UIColor(cgColor: layerBg)) { return true }
        return false
    }

    private static func isOpaque(_ color: UIColor) -> Bool {
        var alpha: CGFloat = 0
        color.getRed(nil, green: nil, blue: nil, alpha: &alpha)
        return alpha == 1.0
    }

    // MARK: - Interactive Action Detection

    private static func hasOwnInteractiveAction(_ view: UIView) -> Bool {
        if let control = view as? UIControl {
            if !control.allTargets.isEmpty || control.showsMenuAsPrimaryAction { return true }
        }
        if hasContentTapGesture(view) { return true }
        return false
    }

    /// Whether the view has a tap gesture that represents content interaction
    /// (excludes VC root views and scroll view containers).
    private static func hasContentTapGesture(_ view: UIView) -> Bool {
        guard !(view.next is UIViewController) else { return false }
        guard !(view is UIScrollView) else { return false }
        if let gestureRecognizers = view.gestureRecognizers {
            return gestureRecognizers.contains(where: { $0 is UITapGestureRecognizer && $0.isEnabled })
        }
        return false
    }

    // MARK: - Accessibility Traits

    private static func traitNames(for traits: UIAccessibilityTraits) -> [String] {
        var names: [String] = []
        if traits.contains(.button) { names.append("button") }
        if traits.contains(.link) { names.append("link") }
        if traits.contains(.header) { names.append("header") }
        if traits.contains(.searchField) { names.append("searchField") }
        if traits.contains(.image) { names.append("image") }
        if traits.contains(.selected) { names.append("selected") }
        if traits.contains(.playsSound) { names.append("playsSound") }
        if traits.contains(.keyboardKey) { names.append("keyboardKey") }
        if traits.contains(.staticText) { names.append("staticText") }
        if traits.contains(.summaryElement) { names.append("summaryElement") }
        if traits.contains(.notEnabled) { names.append("notEnabled") }
        if traits.contains(.updatesFrequently) { names.append("updatesFrequently") }
        if traits.contains(.startsMediaSession) { names.append("startsMediaSession") }
        if traits.contains(.adjustable) { names.append("adjustable") }
        if traits.contains(.allowsDirectInteraction) { names.append("allowsDirectInteraction") }
        if traits.contains(.causesPageTurn) { names.append("causesPageTurn") }
        if traits.contains(.tabBar) { names.append("tabBar") }
        if #available(iOS 17.0, *) {
            if traits.contains(.toggleButton) { names.append("toggleButton") }
        }
        return names
    }

    // MARK: - Float Sanitization

    private static func sanitizeFloat(_ value: Float) -> Float {
        value.isFinite ? value : 0
    }

    // MARK: - Color Helpers

    private static func hexColor(_ color: UIColor?) -> String? {
        guard let color = color else { return nil }
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        guard a > 0 else { return nil }
        return String(
            format: "#%02X%02X%02X%02X",
            Int(r * 255), Int(g * 255), Int(b * 255), Int(a * 255)
        )
    }

    // MARK: - Structural Hash

    private static func hashNode(_ node: SdkViewNode, into hasher: inout Hasher, depth: Int) {
        guard depth < 15 else { return }
        hasher.combine(node.className)
        hasher.combine(node.accessibilityLabel)
        hasher.combine(node.accessibilityIdentifier)
        hasher.combine(node.isAccessibilityElement)
        hasher.combine(node.accessibilityElementsHidden)
        hasher.combine(node.accessibilityTraits)
        hasher.combine(node.accessibilityCustomActions)
        hasher.combine(node.isHidden)
        hasher.combine(node.isUserInteractionEnabled)
        hasher.combine(node.hasTapTarget)
        if let children = node.children {
            hasher.combine(children.count)
            for child in children {
                hashNode(child, into: &hasher, depth: depth + 1)
            }
        }
    }
}
#endif
