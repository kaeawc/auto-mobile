/// ProtoViewer reports one outcome per load to its `onLoaded`/`onLoadFailed` callbacks: the first
/// success or failure settles the load, and later ones (a webView refusal shown again when the
/// network switch turns off, a restored renderer's next first render) are dropped until the next
/// load begins. An MCP `open` therefore never sees a failure after its success.
struct PrototypeLoadReport {
    enum Outcome: Equatable { case loaded, failed }

    private(set) var outcome: Outcome?

    /// A new load: storage is read again, so its first outcome is reported.
    mutating func begin() {
        outcome = nil
    }

    /// True when `result` is the load's first outcome and should be reported.
    mutating func settle(_ result: Outcome) -> Bool {
        guard outcome == nil else { return false }
        outcome = result
        return true
    }
}
