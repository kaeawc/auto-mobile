@MainActor
@available(iOS 17, *)
public func isolated() {}
public protocol Requirements {
    @MainActor
    @available(iOS 17, *)
    func isolatedRequirement()
}
public enum Options {
    @MainActor
    @available(iOS 17, *)
    case isolatedCase
}
public extension Options {
    @objc
    func exposed() {}
    @MainActor
    private func hidden() {}
    func unannotated() {}
}
