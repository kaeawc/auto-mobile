import Foundation

/// Delivers device-orientation-change notifications to a handler.
///
/// `Sendable` because `RotationChangeMonitor` stores one as an immutable `let` (to stay
/// `Sendable` itself), and the handler is `@Sendable` because the concrete signal invokes
/// it from a background notification-delivery queue, not the observing thread.
protocol RotationChangeSignaling: AnyObject, Sendable {
    func startObserving(_ handler: @escaping @Sendable () -> Void)
}
