import Foundation

/// Errors surfaced when relaying database inspection to the in-app SDK.
/// Simulator mismatches retain both identities; Sendable across async clients.
public enum SdkDatabaseError: Error, LocalizedError, Sendable {
    case unavailable(String)
    case wrongSimulator(expectedUdid: String, actualUdid: String)
    case badResponse(String)
    /// The SDK answered `busy_lock`: the app holds a lock on the database past the SDK's bounded wait.
    /// The SDK did answer, so this must not read as "embed the AutoMobile SDK" (#10165).
    case busy
    /// The request was sent and the relay stopped waiting for the answer, so a write may or may not
    /// have been applied. Reporting this as a plain failure invited a retry that applied it twice (#10166).
    case outcomeIndeterminate

    /// Ends with the SDK's wire code so the host maps it like the other SDK error codes.
    static let busyMessage =
        "database busy - the app is holding a lock on this database; retry shortly: \(SdkDatabaseClient.busyCode)"

    static let indeterminateMessage =
        "database request was sent but no answer arrived in time; the outcome is indeterminate "
            + "(a write may still have been applied). Do not retry automatically; query the data to confirm first"

    public var errorDescription: String? {
        switch self {
        case let .wrongSimulator(expected, actual):
            return SdkEndpointError.wrongSimulatorMessage(expectedUdid: expected, actualUdid: actual)
        case let .unavailable(message):
            return message
        case let .badResponse(message):
            return message
        case .busy:
            return Self.busyMessage
        case .outcomeIndeterminate:
            return Self.indeterminateMessage
        }
    }
}
