public enum PlanLoaderError: Error, CustomStringConvertible, Sendable {
    case notFound(String)
    case unreadable(String)

    public var description: String {
        switch self {
        case let .notFound(path):
            return "Plan not found at path: \(path)"
        case let .unreadable(path):
            return "Plan found but could not be read: \(path)"
        }
    }
}
