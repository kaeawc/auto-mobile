/// Production `AutoMobileDaemonEnsuring` delegating to `DaemonManager`. Stateless → `Sendable`.
public struct SystemDaemonEnsurer: AutoMobileDaemonEnsuring {
    public init() {}

    public func ensureDaemonRunning(repoRoot: String?) -> Bool {
        return DaemonManager.ensureDaemonRunning(repoRoot: repoRoot)
    }
}
