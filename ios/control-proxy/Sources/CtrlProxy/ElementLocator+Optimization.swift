import CryptoKit
import Foundation
#if canImport(XCTest) && os(iOS)
    import UIKit
    import XCTest
#endif

extension ElementLocator {
    #if canImport(XCTest) && os(iOS)

        // MARK: - Deterministic ID Generation

        /// Generate a deterministic UUID from a hierarchy path string using SHA-256.
        /// The path encodes the element's position in the tree, ensuring stable IDs
        /// across snapshots when the tree structure hasn't changed.
        func generateDeterministicUuid(from path: String) -> String {
            let data = Data(path.utf8)
            let digest = SHA256.hash(data: data)
            let bytes = Array(digest)
            let hex = bytes.prefix(16).map { String(format: "%02x", $0) }.joined()
            return "\(hex.prefix(8))-\(hex.dropFirst(8).prefix(4))-\(hex.dropFirst(12).prefix(4))-\(hex.dropFirst(16).prefix(4))-\(hex.dropFirst(20).prefix(12))"
        }

        // MARK: - Hierarchy Optimization

        /// Keep the live capture call site on the host-tested optimization path.
        func optimizeHierarchy(_ element: UIElementInfo, isRoot: Bool = false) -> [UIElementInfo] {
            Self.optimizeHierarchy(element, isRoot: isRoot)
        }

        private static let elementClassNames: [XCUIElement.ElementType: String] = [
            .application: "XCUIApplication",
            .window: "UIWindow",
            .button: "UIButton",
            .staticText: "UILabel",
            .textField: "UITextField",
            .secureTextField: "UISecureTextField",
            .textView: "UITextView",
            .image: "UIImageView",
            .icon: "SBIconView",
            .switch: "UISwitch",
            .slider: "UISlider",
            .picker: "UIPickerView",
            .table: "UITableView",
            .cell: "UITableViewCell",
            .scrollView: "UIScrollView",
            .collectionView: "UICollectionView",
            .navigationBar: "UINavigationBar",
            .tabBar: "UITabBar",
            .toolbar: "UIToolbar",
            .searchField: "UISearchBar",
            .alert: "UIAlertController",
            .sheet: "UIActionSheet",
            .progressIndicator: "UIProgressView",
            .activityIndicator: "UIActivityIndicatorView",
            .segmentedControl: "UISegmentedControl",
            .stepper: "UIStepper",
            .datePicker: "UIDatePicker",
            .webView: "WKWebView",
            .link: "UILink",
            .keyboard: "UIKeyboard",
            .key: "UIKeyboardKey",
        ]

        func mapElementType(_ type: XCUIElement.ElementType) -> String {
            Self.elementClassNames[type] ?? "UIView"
        }

        private static let elementRoles: [XCUIElement.ElementType: String] = [
            .button: "button",
            .icon: "button",
            .link: "link",
            .switch: "switch",
            .checkBox: "checkbox",
            .radioButton: "radio",
            .slider: "slider",
            .textField: "textfield",
            .textView: "textfield",
            .secureTextField: "textfield",
            .searchField: "textfield",
            .image: "image",
            .staticText: "text",
            .table: "list",
            .collectionView: "list",
            .cell: "listitem",
            .tab: "tab",
            .progressIndicator: "progressbar",
        ]

        func mapRole(_ type: XCUIElement.ElementType) -> String? {
            Self.elementRoles[type]
        }

        func isScrollableType(_ type: XCUIElement.ElementType) -> Bool {
            switch type {
            case .scrollView, .table, .collectionView, .webView, .textView:
                return true
            default:
                return false
            }
        }

        func isCheckableType(_ type: XCUIElement.ElementType) -> Bool {
            switch type {
            case .switch, .checkBox, .radioButton:
                return true
            default:
                return false
            }
        }

        /// Check if an element type is actually clickable (not just a generic container)
        /// This prevents marking every UIView as clickable just because it's enabled
        func isActuallyClickableType(_ type: XCUIElement.ElementType) -> Bool {
            switch type {
            // Interactive controls
            case .button, .link, .switch, .slider, .stepper, .segmentedControl:
                return true
            // Checkable items
            case .checkBox, .radioButton:
                return true
            // Text input
            case .textField, .textView, .secureTextField, .searchField:
                return true
            // List items (cells are tappable)
            case .cell:
                return true
            // Tab and navigation items
            case .tab, .tabBar:
                return true
            // Pickers
            case .picker, .datePicker:
                return true
            // Alert/sheet buttons
            case .alert, .sheet:
                return true
            // Keyboard keys
            case .key:
                return true
            // Images and icons can be tappable
            case .image, .icon:
                return true
            // Everything else (UIView, window, staticText, etc.) is not inherently clickable
            default:
                return false
            }
        }
    #endif
}

extension ElementLocator {
    // MARK: - Platform-independent hierarchy optimization (host-compiled and host-tested)

    // These pure UIElementInfo helpers live outside the iOS block. On this @MainActor
    // class they are nonisolated static so host tests can call them synchronously.

    /// Front-to-back window position read by src/features/observe/ios/iosWindowLayer.ts.
    nonisolated static let iosWindowLayerExtra = "automobile:iosWindowLayer"

    /// Check if an element has meaningful content that should be preserved
    private nonisolated static func meetsFilterCriteria(_ element: UIElementInfo) -> Bool {
        // String criteria - element has useful identifying information
        let hasStringCriteria =
            element.text != nil ||
            element.resourceId != nil ||
            element.role != nil ||
            element.hintText != nil

        // Boolean criteria - element is interactive
        let hasBooleanCriteria =
            element.clickable == "true" ||
            element.scrollable == "true" ||
            element.focused == "true" ||
            element.selected == "true" ||
            element.checkable == "true"

        return hasStringCriteria || hasBooleanCriteria
    }

    /// Check if a class name is a structural wrapper (no semantic meaning)
    private nonisolated static func isStructuralWrapper(_ className: String?) -> Bool {
        guard let className = className else { return false }
        return ElementLocator.structuralClassNames.contains(className)
    }

    /// Optimizes the hierarchy by:
    /// 1. Promoting children of bounds-only wrapper nodes (structural nodes with only bounds)
    /// 2. Filtering out empty structural nodes
    /// 3. Preserving interactive elements and their children
    ///
    /// This significantly reduces hierarchy size for complex UIs.
    nonisolated static func optimizeHierarchy(_ element: UIElementInfo, isRoot: Bool = false) -> [UIElementInfo] {
        if isRoot {
            return optimizeRootHierarchy(element, stampWindowLayers: true)
        }

        // Check if this element is a bounds-only wrapper (has no useful properties)
        let meetsCriteria = meetsFilterCriteria(element)
        let isStructural = isStructuralWrapper(element.className)
        let isBoundsOnlyWrapper = !meetsCriteria && isStructural

        // Never promote children of interactive elements
        let isInteractive = element.clickable == "true" ||
            element.scrollable == "true" ||
            element.selected == "true"

        // First, recursively optimize children
        var optimizedChildren: [UIElementInfo]?
        if let children = element.node {
            let optimized = children.flatMap { child in
                optimizeHierarchy(child, isRoot: false)
            }
            let cleaned = ElementLocator.cleanupXCTestUIKitNoise(parent: element, children: optimized)
            optimizedChildren = cleaned.isEmpty ? nil : cleaned
        }

        // Only promote children (flatten hierarchy) if this is a bounds-only wrapper AND not interactive
        if isBoundsOnlyWrapper, !isInteractive {
            if let children = optimizedChildren {
                if ElementLocator.containsOnlyUnprotectedScrollBarNoise(children) {
                    return []
                }
                // Promote children - flatten this wrapper node
                return children
            }
            // No children and no content - filter out completely
            return []
        }

        // Keep this element with optimized children. Strip icon artwork after
        // bottom-up wrapper promotion so identified intermediate views cannot
        // hide unlabeled descendants from the icon-level cleanup.
        let retained = Self.copying(element, node: optimizedChildren)
        return [ElementLocator.removingUnlabeledIconDescendants(retained)]
    }

    /// The pre-stamping root pass, shared with the live path for survivor parity tests.
    nonisolated static func optimizeHierarchyUnstampedRoot(_ element: UIElementInfo) -> [UIElementInfo] {
        optimizeRootHierarchy(element, stampWindowLayers: false)
    }

    private nonisolated static func optimizeRootHierarchy(
        _ element: UIElementInfo,
        stampWindowLayers: Bool
    )
        -> [UIElementInfo]
    {
        var survivors: [UIElementInfo] = []
        var origins: [Int?] = []
        for (index, child) in (element.node ?? []).enumerated() {
            let optimized = optimizeHierarchy(child, isRoot: false)
            survivors.append(contentsOf: optimized)
            let origin: Int? = child.className == "UIWindow" ? index : nil
            origins.append(contentsOf: Array(repeating: origin, count: optimized.count))
        }
        // Extras protect noise nodes, so retain original indices and stamp only after cleanup.
        let indices = cleanupXCTestUIKitNoiseIndices(parent: element, children: survivors)
        var children = indices.map { survivors[$0] }
        if stampWindowLayers {
            children = stampingWindowLayers(children, origins: indices.map { origins[$0] })
        }
        let root = copying(element, node: children.isEmpty ? nil : children)
        return [removingUnlabeledIconDescendants(root)]
    }

    private nonisolated static func stampingWindowLayers(
        _ children: [UIElementInfo],
        origins: [Int?]
    )
        -> [UIElementInfo]
    {
        // XCUITest orders windows back to front; count only windows with cleaned survivors.
        let windows = Set(origins.compactMap { $0 }).sorted(by: >)
        guard windows.count >= 2 else { return children }
        return zip(children, origins).map { child, origin in
            guard let origin, let layer = windows.firstIndex(of: origin) else { return child }
            var extras = child.extras ?? [:]
            extras[iosWindowLayerExtra] = String(layer)
            return copying(child, node: child.node, extras: extras)
        }
    }
}
