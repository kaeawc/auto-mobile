/// The concrete reason a daemon-startup attempt succeeded or failed. Surfaced to
/// callers (e.g. the XCTest skip message) so a failure names the actual cause
/// instead of a generic "install and on PATH" note that hides an executable-not-found
/// vs. launch-failure vs. readiness-timeout distinction (#2730).
public enum DaemonStartupResult: Equatable, Sendable {
    case ready
    case executableNotFound
    case packageRunnerNotFound
    case invalidPackageVersion(String)
    case launchFailed
    case packageLaunchFailed(stderr: String)
    case launchTimeout
    case readinessTimeout
    case versionSkew
    case assetVersionSkew

    public var isReady: Bool { self == .ready }

    public var diagnosticMessage: String {
        switch self {
        case .ready:
            return "AutoMobile daemon is ready."
        case .executableNotFound:
            return "Failed to start AutoMobile Daemon: the `auto-mobile` CLI was not found "
                + "(checked /usr/local/bin, /opt/homebrew/bin, /usr/bin, ~/.bun/bin, ~/.local/bin and PATH). "
                + "Install it globally (`bun add -g .`) and ensure its bin directory is on PATH."
        case .packageRunnerNotFound:
            return "Failed to start AutoMobile Daemon: a pinned daemon requires `bunx` or `npx`, but neither "
                + "was found on PATH. Install Bun or Node.js with npm/npx, then retry."
        case let .invalidPackageVersion(version):
            return "Failed to start AutoMobile Daemon: `\(version)` is not an exact package version. "
                + "Set AUTOMOBILE_DAEMON_PACKAGE_VERSION or AUTOMOBILE_VERSION to MAJOR.MINOR.PATCH, then retry."
        case .launchFailed:
            return "Failed to start AutoMobile Daemon: `auto-mobile --daemon start` exited non-zero. "
                + "Check the daemon logs."
        case let .packageLaunchFailed(stderr):
            return "Failed to start AutoMobile Daemon: the package runner exited non-zero. "
                + "Package-runner error: \(stderr.trimmingCharacters(in: .whitespacesAndNewlines))."
        case .launchTimeout:
            return "Failed to start AutoMobile Daemon: the daemon launcher timed out before it completed. "
                + "Check package-registry connectivity and daemon logs."
        case .readinessTimeout:
            return "Failed to start AutoMobile Daemon: the daemon process launched but its socket did not "
                + "become ready before the timeout. Check the daemon logs."
        case .versionSkew:
            return "Failed to start AutoMobile Daemon: a different-version daemon owns the socket and could "
                + "not be reconciled with this runner."
        case .assetVersionSkew:
            return "Failed to start AutoMobile Daemon: the shared daemon was started with a different "
                + "AUTOMOBILE_VERSION pin than this runner. Restart the daemon from this runner's environment."
        }
    }
}
