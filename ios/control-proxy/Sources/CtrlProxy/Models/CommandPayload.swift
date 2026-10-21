import Foundation

public protocol CommandPayload: Sendable {
    var requestId: String? { get }
}
