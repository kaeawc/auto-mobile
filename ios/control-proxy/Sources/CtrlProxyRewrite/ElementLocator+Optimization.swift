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

        /// Check if an element has meaningful content that should be preserved
        private func meetsFilterCriteria(_ element: UIElementInfo) -> Bool {
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
        private func isStructuralWrapper(_ className: String?) -> Bool {
            guard let className = className else { return false }
            return ElementLocator.structuralClassNames.contains(className)
        }

        /// Optimizes the hierarchy by:
        /// 1. Promoting children of bounds-only wrapper nodes (structural nodes with only bounds)
        /// 2. Filtering out empty structural nodes
        /// 3. Preserving interactive elements and their children
        ///
        /// This significantly reduces hierarchy size for complex UIs.
        func optimizeHierarchy(_ element: UIElementInfo, isRoot: Bool = false) -> [UIElementInfo] {
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

            // Root element is always kept
            if isRoot {
                return [ElementLocator.removingUnlabeledIconDescendants(Self.copying(element, node: optimizedChildren))]
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

        func mapElementType(_ type: XCUIElement.ElementType) -> String {
            switch type {
            case .application: return "XCUIApplication"
            case .window: return "UIWindow"
            case .button: return "UIButton"
            case .staticText: return "UILabel"
            case .textField: return "UITextField"
            case .secureTextField: return "UISecureTextField"
            case .textView: return "UITextView"
            case .image: return "UIImageView"
            case .icon: return "SBIconView"
            case .switch: return "UISwitch"
            case .slider: return "UISlider"
            case .picker: return "UIPickerView"
            case .table: return "UITableView"
            case .cell: return "UITableViewCell"
            case .scrollView: return "UIScrollView"
            case .collectionView: return "UICollectionView"
            case .navigationBar: return "UINavigationBar"
            case .tabBar: return "UITabBar"
            case .toolbar: return "UIToolbar"
            case .searchField: return "UISearchBar"
            case .alert: return "UIAlertController"
            case .sheet: return "UIActionSheet"
            case .progressIndicator: return "UIProgressView"
            case .activityIndicator: return "UIActivityIndicatorView"
            case .segmentedControl: return "UISegmentedControl"
            case .stepper: return "UIStepper"
            case .datePicker: return "UIDatePicker"
            case .webView: return "WKWebView"
            case .link: return "UILink"
            case .keyboard: return "UIKeyboard"
            case .key: return "UIKeyboardKey"
            default: return "UIView"
            }
        }

        func mapRole(_ type: XCUIElement.ElementType) -> String? {
            switch type {
            case .button: return "button"
            case .icon: return "button"
            case .link: return "link"
            case .switch: return "switch"
            case .checkBox: return "checkbox"
            case .radioButton: return "radio"
            case .slider: return "slider"
            case .textField, .textView, .secureTextField, .searchField: return "textfield"
            case .image: return "image"
            case .staticText: return "text"
            case .table, .collectionView: return "list"
            case .cell: return "listitem"
            case .tab: return "tab"
            case .progressIndicator: return "progressbar"
            default: return nil
            }
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
