/// Default logger writing tagged lines to stdout. Stateless value type → `Sendable` for free.
public struct StdoutLogger: AutoMobileLogger {
    public init() {}

    public func info(_ message: String) {
        print("[AutoMobile][INFO] \(message)")
    }

    public func warn(_ message: String) {
        print("[AutoMobile][WARN] \(message)")
    }

    public func error(_ message: String) {
        print("[AutoMobile][ERROR] \(message)")
    }
}
