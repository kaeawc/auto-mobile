import Foundation

public enum HingeAngleError: LocalizedError, Sendable {
    case unsupportedPlatform
    case symbolUnavailable(String)
    case serviceCreationFailed
    case payloadTooLarge(Int)
    case dispatchFailed

    public var errorDescription: String? {
        switch self {
        case .unsupportedPlatform:
            return "Setting hinge angle requires an iOS simulator."
        case let .symbolUnavailable(symbol):
            return "iOS simulator hinge support is unavailable: \(symbol)."
        case .serviceCreationFailed:
            return "Could not create the iOS simulator hinge service."
        case let .payloadTooLarge(length):
            return "Hinge event payload is \(length) bytes; maximum is 256."
        case .dispatchFailed:
            return "iOS simulator rejected the hinge angle event."
        }
    }
}
