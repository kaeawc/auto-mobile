import CryptoKit
import Foundation

extension DaemonManager {
    /// The daemon's recorded version from its PID file, trimmed, or nil when absent/unreadable.
    static func readDaemonVersionFromPidFile() -> String? {
        guard let data = FileManager.default.contents(atPath: pidFilePath),
              let pidData = try? JSONDecoder().decode(PidFileData.self, from: data),
              let version = pidData.version?.trimmingCharacters(in: .whitespaces),
              !version.isEmpty
        else {
            return nil
        }
        return version
    }

    /// The daemon's recorded CtrlProxy asset version from its PID file, trimmed, or nil.
    static func readDaemonAssetVersionFromPidFile() -> String? {
        guard let data = FileManager.default.contents(atPath: pidFilePath),
              let pidData = try? JSONDecoder().decode(PidFileData.self, from: data),
              let assetVersion = pidData.assetVersion?.trimmingCharacters(in: .whitespaces),
              !assetVersion.isEmpty
        else {
            return nil
        }
        return assetVersion
    }

    /// The daemon's recorded entry-script path from its PID file, trimmed, or nil when absent.
    static func readDaemonEntryScriptFromPidFile() -> String? {
        guard let data = FileManager.default.contents(atPath: pidFilePath),
              let pidData = try? JSONDecoder().decode(PidFileData.self, from: data),
              let entryScript = pidData.entryScript?.trimmingCharacters(in: .whitespaces),
              !entryScript.isEmpty
        else {
            return nil
        }
        return entryScript
    }

    /// The daemon's recorded build-identity hash from its PID file, trimmed, or nil when absent.
    static func readDaemonBuildIdFromPidFile() -> String? {
        guard let data = FileManager.default.contents(atPath: pidFilePath),
              let pidData = try? JSONDecoder().decode(PidFileData.self, from: data),
              let buildId = pidData.buildId?.trimmingCharacters(in: .whitespaces),
              !buildId.isEmpty
        else {
            return nil
        }
        return buildId
    }

    /// Short content hash of an entry script (sha256, first 16 hex chars) — matches the daemon's
    /// `computeBuildIdentity`, so the value compares equal to the daemon's own recorded build id.
    static func computeBuildId(_ entryScript: String) -> String? {
        guard let data = FileManager.default.contents(atPath: entryScript) else {
            return nil
        }
        let hex = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return String(hex.prefix(16))
    }

    /// When a caller supplies a repo root with a built entrypoint, whether the running daemon was
    /// started from a *different* build (#2744). The daemon must identify both the expected
    /// entry-script path and its content hash: the path keeps separately copied runtime artifacts
    /// (such as `dist/schemas/`) scoped to this checkout, while the hash catches an in-place rebuild.
    /// Falls back to the entry-script path when a hash is unavailable. No-op without a repoRoot
    /// build or when neither signal is available.
    static func requiresRepoRootBuildSkew(
        daemonBuildId: String?,
        daemonEntryScript: String?,
        repoRoot: String?
    )
        -> Bool
    {
        guard let expectedEntry = resolveRepoRootDaemonEntryScript(repoRoot) else {
            return false
        }
        let expectedHash = computeBuildId(expectedEntry)
        let daemonHash = daemonBuildId?.trimmingCharacters(in: .whitespaces)
        let daemonEntry = daemonEntryScript?.trimmingCharacters(in: .whitespaces)
        let hasExpectedEntry = daemonEntry == expectedEntry
        guard let expectedHash = expectedHash,
              let daemonHash = daemonHash, !daemonHash.isEmpty, daemonHash != "unknown"
        else {
            return daemonEntry.map { !$0.isEmpty && !hasExpectedEntry } ?? false
        }
        return daemonHash != expectedHash || !hasExpectedEntry
    }

    /// The release portion of a version string — everything before the `+g<sha>` dev stamp.
    /// Mirrors the daemon's `releaseVersion`, so a git-stamped source-checkout daemon compares
    /// equal to this runner's plain release.
    static func releaseVersion(_ version: String) -> String {
        return String(version.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)
            .first ?? Substring(version))
    }

    /// Whether an already-running daemon must be restarted before reuse because its recorded
    /// version does not match this runner's (#2744). Compares release portions; a blank/unknown
    /// version on either side yields false so an unidentifiable daemon is not thrashed.
    static func requiresVersionSkewRestart(daemonVersion: String?, clientVersion: String) -> Bool {
        guard let daemonVersion = daemonVersion?.trimmingCharacters(in: .whitespaces), !daemonVersion.isEmpty else {
            return false
        }
        let client = clientVersion.trimmingCharacters(in: .whitespaces)
        if client.isEmpty {
            return false
        }
        return releaseVersion(daemonVersion) != releaseVersion(client)
    }

    static func resolveCallerAssetVersionPin(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String? {
        guard let pinned = environment["AUTOMOBILE_VERSION"]?.trimmingCharacters(in: .whitespaces),
              !pinned.isEmpty,
              pinned.lowercased() != "latest",
              pinned.lowercased() != "unknown"
        else {
            return nil
        }
        return pinned
    }

    static func requiresAssetVersionPinFailure(
        daemonAssetVersion: String?,
        callerPinnedVersion: String?
    ) -> Bool {
        let daemon = daemonAssetVersion?.trimmingCharacters(in: .whitespaces) ?? ""
        guard let caller = callerPinnedVersion?.trimmingCharacters(in: .whitespaces),
              !caller.isEmpty,
              caller.lowercased() != "latest",
              caller.lowercased() != "unknown"
        else {
            return false
        }
        return daemon != caller
    }

    static func requiresImmediateAssetVersionPinFailure(
        assetVersionSkew: Bool,
        versionSkew: Bool,
        buildSkew: Bool
    ) -> Bool {
        assetVersionSkew && !versionSkew && !buildSkew
    }
}
