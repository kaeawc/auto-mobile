/// Outcome of launching an `auto-mobile --daemon <subcommand>` process, distinguishing a
/// missing executable from a launched-but-failed process so callers can report the real cause.
///
/// Lifted to a top-level internal type in the rewrite (it was nested in `DaemonManager` in the
/// reference but is not part of the public API surface).
enum DaemonSubcommandOutcome: Equatable, Sendable {
    case launched
    case executableNotFound
    case packageRunnerNotFound
    case invalidPackageVersion(String)
    case failed(stderr: String? = nil)
    case packageFailed(stderr: String? = nil)
    case timedOut
}
