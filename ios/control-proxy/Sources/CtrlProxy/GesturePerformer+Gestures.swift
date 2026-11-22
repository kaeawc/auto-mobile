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
    nonisolated static func consumerUsage(for button: String) throws -> UInt32 {
        switch button {
        case "volume_up": return 0xE9
        case "volume_down": return 0xEA
        case "power": return 0x30
        default: throw GestureError.notSupported("Consumer button: \(button)")
        }
    }

    /// HID keyboard-page (0x07) usages for a letter shortcut chord, modifiers first and the
    /// letter last, or nil when the key is not a letter or has no modifiers (#18908).
    nonisolated static func letterChordUsages(key: String, modifiers: [String]) throws -> [UInt32]? {
        let scalars = Array(key.lowercased().unicodeScalars)
        guard scalars.count == 1, let letter = scalars.first, ("a" ... "z").contains(letter),
              !modifiers.isEmpty
        else { return nil }
        var usages: [UInt32] = []
        for modifier in modifiers.map({ $0.lowercased() }) {
            let usage: UInt32
            switch modifier {
            case "ctrl": usage = 0xE0
            case "shift": usage = 0xE1
            case "alt": usage = 0xE2
            case "meta": usage = 0xE3
            default: throw GestureError.notSupported("Keyboard modifier: \(modifier)")
            }
            if !usages.contains(usage) { usages.append(usage) }
        }
        let letterA = Unicode.Scalar("a").value
        return usages + [0x04 + letter.value - letterA]
    }

    nonisolated static func swipeVelocity(distance: Double, duration: TimeInterval) -> Double? {
        guard distance.isFinite, duration.isFinite, distance > 0, duration > 0 else { return nil }
        return min(max(distance / duration, 100), 10000)
    }

    nonisolated static func longPressDuration(_ milliseconds: Int?) -> TimeInterval {
        TimeInterval(milliseconds ?? 1000) / 1000.0
    }
}
