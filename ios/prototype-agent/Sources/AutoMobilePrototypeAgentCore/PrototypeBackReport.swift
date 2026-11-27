/// Whether the prototype handles Back itself (#19086): an open drawer closes, or a stack with a pushed
/// route pops. While it does, an app host gives Back to the prototype instead of closing it, and only
/// at the root route does Back close the prototype, as on Android.
extension PrototypeSession {
    var handlesBack: Bool {
        guard let spec else { return false }
        let drawerOpen = spec.root.openModals(state: state, pages: pages, stacks: stacks, data: data)
            .contains { $0.type == "drawer" }
        return drawerOpen || stackPopTarget != nil
    }
}

/// Reports the first value and each later change once, so a host updates its chrome only on a change.
struct PrototypeBackReport {
    private(set) var last: Bool?

    mutating func report(handlesBack: Bool) -> Bool? {
        guard handlesBack != last else { return nil }
        last = handlesBack
        return handlesBack
    }
}
