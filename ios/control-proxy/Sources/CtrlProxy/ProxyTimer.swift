import Foundation

protocol ProxyTimer: Sendable {
    /// Current time in milliseconds.
    func now() -> Int64

    /// Wait for the specified number of milliseconds.
    func wait(milliseconds: Int64) async

    /// Schedule a callback to run after the specified number of milliseconds.
    func schedule(after milliseconds: Int64, callback: @escaping @Sendable () -> Void)
}
