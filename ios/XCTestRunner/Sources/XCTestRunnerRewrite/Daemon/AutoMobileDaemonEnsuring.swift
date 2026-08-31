/// The daemon lifecycle boundary used by plan execution. Kept injectable (and `Sendable`, so the
/// Sendable executor can hold it) so executor tests never start or restart a real shared daemon.
public protocol AutoMobileDaemonEnsuring: Sendable {
    func ensureDaemonRunning(repoRoot: String?) -> Bool
}
