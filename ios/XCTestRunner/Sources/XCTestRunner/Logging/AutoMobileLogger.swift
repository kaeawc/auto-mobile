/// Logging seam. Refines `Sendable` so the (Sendable) executor and its collaborators can hold a
/// logger across isolation domains.
public protocol AutoMobileLogger: Sendable {
    func info(_ message: String)
    func warn(_ message: String)
    func error(_ message: String)
}
