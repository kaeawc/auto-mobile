import Foundation

/// Clock + sleep seam, injected so executor/recovery tests never sleep in real time. Refines
/// `Sendable` so a Sendable holder can retain it.
public protocol AutoMobileTimer: Sendable {
    func now() -> TimeInterval
    func sleep(seconds: TimeInterval)
}
