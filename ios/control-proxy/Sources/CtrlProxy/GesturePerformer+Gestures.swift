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

    nonisolated static func swipeVelocity(distance: Double, duration: TimeInterval) -> Double? {
        guard distance.isFinite, duration.isFinite, distance > 0, duration > 0 else { return nil }
        return min(max(distance / duration, 100), 10000)
    }

    nonisolated static func longPressDuration(_ milliseconds: Int?) -> TimeInterval {
        TimeInterval(milliseconds ?? 1000) / 1000.0
    }
}
