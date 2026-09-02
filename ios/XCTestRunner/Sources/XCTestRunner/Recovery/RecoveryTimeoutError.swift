import Foundation

/// Thrown when a bridged async call does not complete within its timeout.
struct RecoveryTimeoutError: Error, CustomStringConvertible, Equatable, Sendable {
    let timeoutSeconds: TimeInterval
    var description: String { "Recovery model call timed out after \(timeoutSeconds)s" }
}
