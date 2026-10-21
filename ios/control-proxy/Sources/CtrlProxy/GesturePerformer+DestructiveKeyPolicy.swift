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
    nonisolated static func canVerifyDestructiveKey(focusedValue: String?) -> Bool {
        focusedValue != nil
    }

    enum DestructiveKeyOutcome: Equatable {
        case deleted
        case boundaryNoOp
        case noEffect
    }

    nonisolated static func destructiveKeyOutcome(before: String, after: String) -> DestructiveKeyOutcome {
        if before.isEmpty { return .boundaryNoOp }
        return after.count < before.count ? .deleted : .noEffect
    }

    enum FocusedElementKind: CaseIterable {
        case textField, secureTextField, textView, searchField, other, unsupported
    }

    enum FocusedValueReliability: Equatable {
        case reliable, other, unreliable
    }

    nonisolated static func focusedValueReliability(for kind: FocusedElementKind) -> FocusedValueReliability {
        switch kind {
        case .textField, .secureTextField, .textView, .searchField: return .reliable
        case .other: return .other
        case .unsupported: return .unreliable
        }
    }

    enum DestructiveKeyPostCondition: Equatable {
        case delivered, failed, deliveredWithWarning, boundaryNoOp
    }

    nonisolated static func destructiveKeyPostCondition(
        kind: FocusedElementKind, before: String, after: String
    )
        -> DestructiveKeyPostCondition
    {
        switch destructiveKeyOutcome(before: before, after: after) {
        case .deleted: return .delivered
        case .boundaryNoOp: return .boundaryNoOp
        case .noEffect:
            if focusedValueReliability(for: kind) == .reliable { return .failed }
            return before == after ? .deliveredWithWarning : .delivered
        }
    }

    nonisolated static func destructiveKeyWarning(key: String) -> String {
        "Key '\(key)' was delivered, but the accessibility value did not change; " +
            "this element type does not reliably reflect edits, so delivery could not be confirmed"
    }

    nonisolated static func validateDestructiveKeyModifiers(normalizedKey: String, modifiers: [String]) throws {
        guard normalizedKey == "backspace" || normalizedKey == "delete", !modifiers.isEmpty else { return }
        throw GestureError.notSupported(
            "Modifiers (\(modifiers.joined(separator: ", "))) are not supported with \(normalizedKey); send the key without modifiers"
        )
    }

    nonisolated static func fieldText(snapshotValue: String?, value: String?, placeholderValue: String?) -> String {
        guard snapshotValue != nil, value != placeholderValue else { return "" }
        return value ?? ""
    }

    nonisolated static func forwardDeleteMarker(for original: String) -> String? {
        for codePoint in 0xE000 ... 0xE007 {
            guard let scalar = UnicodeScalar(codePoint) else { continue }
            let marker = String(scalar)
            if !original.contains(marker) { return marker }
        }
        return nil
    }

    nonisolated static func forwardDeleteMarkerIndex(original: String, probed: String, marker: String) -> Int? {
        guard probed.count == original.count + 1,
              let range = probed.range(of: marker),
              !probed[range.upperBound...].contains(marker),
              String(probed[..<range.lowerBound]) + String(probed[range.upperBound...]) == original
        else { return nil }
        return probed.distance(from: probed.startIndex, to: range.lowerBound)
    }

    nonisolated static func forwardDeleteResult(original: String, caretIndex: Int) -> String? {
        guard caretIndex >= 0, caretIndex < original.count else { return nil }
        return String(original.prefix(caretIndex)) + String(original.dropFirst(caretIndex + 1))
    }
}
