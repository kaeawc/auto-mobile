import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

extension GesturePerformer {
    /// Pressing a key needs a first responder, while text editing still needs
    /// evidence that an `.other` snapshot is a text input.
    nonisolated static func isFocusedSnapshotCandidate(
        hasFocus: Bool, isKnownTextInput: Bool, isOther: Bool,
        hasTextInputEvidence: Bool, forKeyPress: Bool
    )
        -> Bool
    {
        hasFocus && (isKnownTextInput || (isOther && (forKeyPress || hasTextInputEvidence)))
    }

    enum SnapshotFocusElementType {
        case textField, secureTextField, searchField, textView, other
    }

    nonisolated static func acceptSnapshotFocus(
        keyboardVisible: Bool, focusedElementType: SnapshotFocusElementType
    )
        -> Bool
    {
        if keyboardVisible { return true }
        switch focusedElementType {
        case .textField, .secureTextField, .searchField, .textView: return true
        case .other: return false
        }
    }

    struct FocusDiagnosticEntry {
        let kind: String
        let identifier: String
        let hasFocus: Bool
        let isSelected: Bool
        let valueLength: Int
        let frame: CGRect
    }

    struct FocusDiagnosticSummary {
        var counts: [String: Int] = [:]
        var entries: [String: [FocusDiagnosticEntry]] = [:]
        var visitedNodes = 0
        var truncated = false
    }

    /// Visit at most `maxNodes` snapshot nodes, without building a second tree.
    nonisolated static func boundedFocusDiagnostic<Node>(
        root: Node,
        maxNodes: Int = 200,
        maxDepth: Int = 64,
        children: (Node) -> [Node],
        describe: (Node) -> FocusDiagnosticEntry?
    )
        -> FocusDiagnosticSummary
    {
        var summary = FocusDiagnosticSummary()
        var pending: [(node: Node, depth: Int)] = [(root, 0)]
        while let current = pending.popLast() {
            if summary.visitedNodes >= maxNodes {
                summary.truncated = true
                break
            }
            summary.visitedNodes += 1
            if let entry = describe(current.node) {
                summary.counts[entry.kind, default: 0] += 1
                if summary.entries[entry.kind, default: []].count < 5 {
                    summary.entries[entry.kind, default: []].append(entry)
                }
            }
            let descendants = children(current.node)
            if current.depth >= maxDepth {
                if !descendants.isEmpty { summary.truncated = true }
                continue
            }
            pending.append(contentsOf: descendants.reversed().map { ($0, current.depth + 1) })
        }
        return summary
    }
}
