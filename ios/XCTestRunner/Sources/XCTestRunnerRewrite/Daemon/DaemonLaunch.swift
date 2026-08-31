/// A resolved daemon launch: either a concrete process to spawn, or the reason no launch is possible.
enum DaemonLaunch: Equatable, Sendable {
    case process(executable: String, arguments: [String])
    case executableNotFound
    case packageRunnerNotFound
    case invalidPackageVersion(String)
}
