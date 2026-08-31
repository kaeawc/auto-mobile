public enum AutoMobileTestCaseError: Error, CustomStringConvertible {
    case missingPlanPath
    case invalidEndpoint(String)
    case executorUnavailable
    case devicePoolUnavailable(String)

    public var description: String {
        switch self {
        case .missingPlanPath:
            return "Missing AutoMobile test plan path."
        case let .invalidEndpoint(endpoint):
            return "Invalid MCP endpoint: \(endpoint)"
        case .executorUnavailable:
            return "AutoMobile plan executor is unavailable."
        case let .devicePoolUnavailable(details):
            return "Device pool unavailable: \(details)"
        }
    }
}
