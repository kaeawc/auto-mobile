/// Which window presents in-app UI such as `SFSafariViewController` for `links.open` (#14238).
/// The injected agent draws over the app in its own overlay window, so a controller presented from
/// the app's key window would sit underneath the prototype. The overlay wins while it shows a
/// prototype; otherwise the key window, then any visible window.
enum PrototypePresenterWindow {
    struct Candidate: Equatable {
        /// The agent's overlay window, showing a prototype.
        let isPrototypeOverlay: Bool
        let isKey: Bool
        let isHidden: Bool
    }

    static func index(of candidates: [Candidate]) -> Int? {
        let visible = candidates.indices.filter { !candidates[$0].isHidden }
        return visible.first { candidates[$0].isPrototypeOverlay }
            ?? visible.first { candidates[$0].isKey }
            ?? visible.first
    }
}
