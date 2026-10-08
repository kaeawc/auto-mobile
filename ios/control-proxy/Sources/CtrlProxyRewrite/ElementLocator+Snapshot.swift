import Foundation
#if canImport(XCTest) && os(iOS)
    import os
    import UIKit
    import XCTest
#endif

extension ElementLocator {
    #if canImport(XCTest) && os(iOS)
        /// Collect text-input element snapshots by walking the already-captured
        /// application snapshot tree (issue #5474).
        ///
        /// This replaces the previous live-query approach
        /// (`descendants(matching:).allElementsBoundByIndex` + per-candidate
        /// `snapshot()`), which forced the app to re-serialize its accessibility
        /// tree over IPC once per element type plus once per candidate. Because the
        /// root snapshot is already in hand, the same text-input nodes are read
        /// locally with no further IPC. Zero-area nodes are skipped to mirror the
        /// old `!frame.isEmpty` visibility filter.
        static func collectTextInputSnapshots(from snapshot: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
            return collectTextInputNodes(
                snapshot,
                isTextInput: { textInputElementTypes.contains($0.elementType) },
                frame: { $0.frame },
                children: { $0.children }
            )
        }

        /// Get system alerts from the app snapshot and springboard.
        /// Checks two sources because system permission dialogs may appear in either:
        /// 1. The foreground app's accessibility tree (common on modern iOS)
        /// 2. SpringBoard's accessibility tree (for some system-level dialogs)
        /// Alert elements are extracted separately from the main hierarchy tree to ensure
        /// they are always visible as top-level children and never lost to optimization.
        /// Deduplicates by alert label text to avoid showing the same alert twice.
        func getSystemAlerts(
            appSnapshot: XCUIElementSnapshot,
            truncationReasons: inout Set<String>,
            keyboardFocus: KeyboardFocus? = nil
        )
            throws -> (alerts: [UIElementInfo], rotation: Int?)
        {
            // Check for alerts in the app's own snapshot tree
            let appAlertSnapshots = collectAlertElements(from: appSnapshot)
            let appAlerts = appAlertSnapshots.map { snapshot in
                buildElementInfoFromSnapshot(
                    snapshot,
                    depth: 0,
                    screenBounds: snapshot.frame,
                    truncationReasons: &truncationReasons,
                    keyboardFocus: keyboardFocus
                )
            }

            // Also check SpringBoard for alerts not in the app's tree. A system-owned
            // sheet can cover a still-foreground app without appearing anywhere in the
            // app snapshot (for example, iOS's "Open in <app>?" confirmation). In that
            // state the app provides no precondition that can safely prove SpringBoard
            // has no alert, so every non-SpringBoard capture must inspect both windows.
            // When the foreground app IS SpringBoard, `appSnapshot` already is
            // SpringBoard's tree and a second snapshot would be redundant.
            let foregroundIsSpringboard = (foregroundBundleId ?? "com.apple.springboard") == "com.apple.springboard"
            let runSpringboardSnapshot = Self.shouldSnapshotSpringboardForAlerts(
                foregroundIsSpringboard: foregroundIsSpringboard
            )
            let springboardCapture = try getAlertsFromSpringboard(
                runSnapshot: runSpringboardSnapshot,
                appFrame: appSnapshot.frame,
                truncationReasons: &truncationReasons,
                keyboardFocus: keyboardFocus
            )

            // Deduplicate by alert label text
            var seenLabels: Set<String> = []
            var combined: [UIElementInfo] = []

            for alert in appAlerts {
                let label = alert.text ?? ""
                if !seenLabels.contains(label) {
                    seenLabels.insert(label)
                    combined.append(alert)
                }
            }

            for alert in springboardCapture.alerts {
                let label = alert.text ?? ""
                if !seenLabels.contains(label) {
                    seenLabels.insert(label)
                    combined.append(alert)
                }
            }

            if !combined.isEmpty {
                print(
                    "[ElementLocator] Found \(combined.count) system alert(s): appAlerts=\(appAlerts.count), springboardAlerts=\(springboardCapture.alerts.count)"
                )
            }

            return (combined, springboardCapture.rotation)
        }

        /// Get alerts from a fresh springboard snapshot.
        /// Uses single snapshot() + tree traversal instead of .alerts query which can hang
        /// indefinitely on system permission dialogs, blocking the main thread.
        /// IMPORTANT: Creates a new XCUIApplication each call to avoid stale cached state.
        ///
        /// When `runSnapshot` is false the expensive `springboard.snapshot()` IPC is
        /// skipped and no alerts are returned, but the (cheap, local) rotation sample
        /// is still captured so the caller's rotation-agreement check is unaffected
        /// (issue #5474).
        ///
        /// SpringBoard alert frames are screen-space. When the observed app is an inset iPadOS
        /// window (#6635), they are shifted into the app's window-relative space before merging,
        /// so every node in the observed hierarchy shares one space and the gesture path's single
        /// window-origin translation is correct for alert taps too.
        private func getAlertsFromSpringboard(
            runSnapshot: Bool,
            appFrame: CGRect,
            truncationReasons: inout Set<String>,
            keyboardFocus: KeyboardFocus? = nil
        )
            throws -> (alerts: [UIElementInfo], rotation: Int?)
        {
            let capture: (alertSnapshots: [XCUIElementSnapshot], springboardFrame: CGRect, rotation: Int?) =
                try catchingObjCException {
                    let capture = DeviceRotation.capture { () -> ([XCUIElementSnapshot], CGRect) in
                        guard runSnapshot else {
                            return ([], .zero)
                        }
                        let freshSpringboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                        guard let snapshot = try? freshSpringboard.snapshot() else {
                            return ([], .zero)
                        }
                        return (self.collectAlertElements(from: snapshot), snapshot.frame)
                    }
                    return (
                        alertSnapshots: capture.value.0, springboardFrame: capture.value.1, rotation: capture.rotation
                    )
                }

            let offset = capture.alertSnapshots.isEmpty ? .zero : Self.springboardAlertOffset(
                appFrame: appFrame,
                springboardFrame: capture.springboardFrame,
                windowFrame: { self.observedAppWindowFrame() }
            )
            let alerts = capture.alertSnapshots.map { snapshot in
                buildElementInfoFromSnapshot(
                    snapshot,
                    depth: 0,
                    screenBounds: snapshot.frame.offsetBy(dx: offset.x, dy: offset.y),
                    truncationReasons: &truncationReasons,
                    keyboardFocus: keyboardFocus,
                    coordinateOffset: offset
                )
            }
            return (alerts, capture.rotation)
        }

        /// Screen frame of the observed app's window, read only for a non-screen-sized app with a
        /// SpringBoard alert to merge. Like the gesture path's window read, this is a live query
        /// that can stall on a suspended app; the app snapshot taken just before it has already
        /// queried the same app, so it adds no new precondition.
        private func observedAppWindowFrame() -> CGRect? {
            guard let bundleId = foregroundBundleId else { return nil }
            do {
                return try catchingObjCException {
                    XCUIApplication(bundleIdentifier: bundleId).windows.firstMatch.frame
                }
            } catch {
                Logger(subsystem: "dev.jasonpearson.automobile", category: "ElementLocator")
                    .warning("app window frame unavailable; SpringBoard alerts stay screen-space: \(error)")
                return nil
            }
        }

        /// Recursively collect system-dialog snapshots from a snapshot tree.
        ///
        /// iOS exposes classic permission dialogs as `.alert`, but newer
        /// SpringBoard confirmations such as "Open in <app>?" as `.sheet`.
        /// Used instead of live `.alerts` / `.sheets` queries, which can hang on
        /// system-owned dialogs.
        func collectAlertElements(from snapshot: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
            if snapshot.elementType == .alert || snapshot.elementType == .sheet {
                // Found a dialog - return it without recursing into children
                // (buildElementInfoFromSnapshot will handle its children).
                return [snapshot]
            }
            var alerts: [XCUIElementSnapshot] = []
            for child in snapshot.children {
                alerts.append(contentsOf: collectAlertElements(from: child))
            }
            return alerts
        }

        /// Check whether a zero-area wrapper contains an element with a usable frame.
        private func hasNonZeroAreaDescendant(_ snapshot: XCUIElementSnapshot) -> Bool {
            snapshot.children.contains { child in
                let frame = child.frame
                return !Self.hasZeroArea(frame) || hasNonZeroAreaDescendant(child)
            }
        }

        /// Build element info from XCUIElementSnapshot - all data is already captured, no IPC calls
        /// Applies early filtering: offscreen elements, empty zero-area subtrees
        /// Only sets boolean fields when true (nil = false) to reduce JSON size
        func buildElementInfoFromSnapshot(
            _ snapshot: XCUIElementSnapshot,
            depth: Int,
            screenBounds: CGRect,
            truncationReasons: inout Set<String>,
            parentPath: String = "",
            childIndex: Int = 0,
            keyboardFocus: KeyboardFocus? = nil,
            disableAllFiltering: Bool = false,
            enclosingFrame: CGRect? = nil,
            coordinateOffset: CGPoint = .zero
        )
            -> UIElementInfo
        {
            let resolved = Self.screenFrame(
                snapshot.frame,
                enclosingFrame: enclosingFrame,
                coordinateOffset: coordinateOffset
            )
            let frame = resolved.frame

            // Skip zero-area elements
            let hasZeroArea = Self.hasZeroArea(frame)

            let bounds = ElementBounds(clamping: frame)

            // Get identifier
            let identifier = snapshot.identifier

            // Build deterministic path for viewId generation
            let resId = identifier.isEmpty ? nil : identifier
            let segment: String
            if let rid = resId {
                segment = "\(childIndex):\(rid)"
            } else {
                segment = "\(childIndex)"
            }
            let currentPath = parentPath.isEmpty ? segment : "\(parentPath)/\(segment)"
            let viewId = resId ?? generateDeterministicUuid(from: currentPath)

            // Get children from snapshot (already captured - fast!)
            // Filter out offscreen children and zero-area subtrees without usable frames
            // Alert/sheet elements are SKIPPED here because they are extracted separately
            // by collectAlertElements() and added as top-level system dialogs. This ensures
            // system confirmations are always visible and never lost to hierarchy optimization.
            let parentClassName = mapElementType(snapshot.elementType)
            var childNodes: [UIElementInfo]?
            if depth < ElementLocator.maxDepth {
                let children = snapshot.children
                if !children.isEmpty {
                    var filteredChildren = children.enumerated().compactMap { idx, child -> UIElementInfo? in
                        // Skip dialog elements - they are extracted separately to ensure
                        // they're always visible as top-level children.
                        if child.elementType == .alert || child.elementType == .sheet {
                            return nil
                        }

                        let childFrame = Self.screenFrame(
                            child.frame,
                            enclosingFrame: frame,
                            coordinateOffset: resolved.offset
                        ).frame

                        if Self.hasZeroArea(childFrame) {
                            // A zero-area wrapper can still contain on-screen descendants.
                            guard Self.shouldKeepZeroAreaChild(
                                hasNonZeroAreaDescendant: hasNonZeroAreaDescendant(child)
                            ) else {
                                return nil
                            }
                        } else {
                            // Skip completely offscreen children (with margin)
                            let margin: CGFloat = 50
                            let expandedScreen = screenBounds.insetBy(dx: -margin, dy: -margin)
                            if !expandedScreen.intersects(childFrame) {
                                return nil
                            }
                        }

                        return buildElementInfoFromSnapshot(
                            child,
                            depth: depth + 1,
                            screenBounds: screenBounds,
                            truncationReasons: &truncationReasons,
                            parentPath: currentPath,
                            childIndex: idx,
                            keyboardFocus: keyboardFocus,
                            disableAllFiltering: disableAllFiltering,
                            enclosingFrame: frame,
                            coordinateOffset: resolved.offset
                        )
                    }

                    if !disableAllFiltering {
                        // Collapse same-type text-input children (e.g. UITextField inside UITextField)
                        // that are internal UIKit subviews with no unique identifying properties.
                        filteredChildren = ElementLocator.collapseSameTypeTextInputChildren(
                            parentClassName: parentClassName,
                            children: filteredChildren
                        )

                        // Deduplicate siblings with identical type + bounds + no unique properties.
                        filteredChildren = ElementLocator.deduplicateSiblings(filteredChildren)
                    }

                    childNodes = filteredChildren.isEmpty ? nil : filteredChildren
                }
            } else if let reason = Self.depthCapTruncationReason(
                depth: depth,
                maxDepth: ElementLocator.maxDepth,
                hasChildren: !snapshot.children.isEmpty
            ) {
                truncationReasons.insert(reason)
            }

            // Determine boolean properties - only set to "true", leave nil for false
            // This significantly reduces JSON size
            let isEnabled = snapshot.isEnabled

            // Only mark specific element types as clickable (not generic UIViews)
            let isClickableType = isActuallyClickableType(snapshot.elementType)
            let isClickable = isEnabled && isClickableType

            let isScrollable = isScrollableType(snapshot.elementType)
            let isCheckable = isCheckableType(snapshot.elementType)
            let isSelected = snapshot.isSelected
            // UISwitch reports toggle state via value ("0"/"1"), not isSelected
            let isChecked: Bool
            if isCheckable, let value = snapshot.value as? String {
                isChecked = value == "1"
            } else {
                isChecked = isCheckable && isSelected
            }
            // Snapshot focus preserves each node's captured hasFocus; live focus remains
            // authoritative for text inputs because some iPhone UIKit snapshots omit focus.
            let isTextInput = snapshot.elementType == .textField
                || snapshot.elementType == .textView
                || snapshot.elementType == .secureTextField
                || snapshot.elementType == .searchField
            let hasFocus = Self.resolveKeyboardFocus(
                nodeFrame: frame,
                isTextInput: isTextInput,
                snapshotHasFocus: snapshot.hasFocus,
                keyboardFocus: keyboardFocus
            )
            let isPassword = snapshot.elementType == .secureTextField

            // Only include actions for text input elements (click is implied by clickable)
            var actions: [String]?
            if isEnabled && (
                snapshot.elementType == .textField || snapshot.elementType == .textView ||
                    snapshot.elementType == .secureTextField || snapshot.elementType == .searchField
            ) {
                actions = ["set_text", "clear_text"]
            }

            // Get label - use for text (don't duplicate in content-desc)
            let label = snapshot.label.isEmpty ? nil : snapshot.label

            // For text inputs, surface the entered value separately from the
            // accessibility label (which is typically the placeholder for
            // UISearchBar / UITextField). Mask password content to avoid
            // leaking secrets through the hierarchy.
            var enteredValue: String?
            if isTextInput, let raw = snapshot.value as? String, !raw.isEmpty {
                enteredValue = isPassword ? String(repeating: "•", count: raw.count) : raw
            }

            return UIElementInfo(
                text: label,
                value: enteredValue,
                textSize: nil,
                contentDesc: nil, // Don't duplicate - label is in text
                resourceId: resId,
                className: parentClassName,
                bounds: hasZeroArea ? nil : bounds, // Don't include bounds for zero-area elements
                // Only include boolean fields when true (nil = false)
                clickable: isClickable ? "true" : nil,
                enabled: nil, // Don't include enabled - it's almost always true and implied by clickable
                focusable: nil, // Don't include - almost all elements are focusable on iOS
                focused: hasFocus ? "true" : nil,
                accessibilityFocused: nil,
                scrollable: isScrollable ? "true" : nil,
                password: isPassword ? "true" : nil,
                checkable: isCheckable ? "true" : nil,
                checked: isChecked ? "true" : nil,
                selected: isSelected ? "true" : nil,
                longClickable: nil, // Don't include - same as clickable on iOS
                semanticLinks: snapshot.elementType == .link
                    ? label.map { [SemanticLink(text: $0, occurrence: 0)] }
                    : nil,
                testTag: nil, // Don't duplicate - identifier is in resourceId
                role: mapRole(snapshot.elementType),
                stateDescription: nil,
                errorMessage: nil,
                hintText: snapshot.placeholderValue,
                viewId: viewId,
                extras: nil,
                actions: actions,
                node: childNodes
            )
        }
    #endif
}
