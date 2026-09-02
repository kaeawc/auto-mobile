import Foundation

extension DaemonManager {
    /// The package version a non-checkout XCTestRunner daemon launch should use. An explicit
    /// daemon-package pin takes precedence over the shared release pin, matching Android.
    static func resolveDaemonPackageVersion(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String? {
        let explicitPin = environment["AUTOMOBILE_DAEMON_PACKAGE_VERSION"]?
            .trimmingCharacters(in: .whitespaces)
        if let explicitPin, !explicitPin.isEmpty {
            return explicitPin
        }

        guard let automobileVersion = environment["AUTOMOBILE_VERSION"]?.trimmingCharacters(in: .whitespaces),
              !automobileVersion.isEmpty
        else {
            return nil
        }
        // `AUTOMOBILE_VERSION=latest` is the shared asset-version sentinel. Convert it to this
        // runner's baked concrete release rather than passing a floating package tag to bunx/npx.
        return automobileVersion.lowercased() == "latest" ? AutoMobileVersion.current : automobileVersion
    }

    static func daemonPackageVersionResolution(_ packageVersion: String?) -> DaemonPackageVersionResolution {
        guard let version = packageVersion?.trimmingCharacters(in: .whitespaces), !version.isEmpty else {
            return .absent
        }
        guard version.range(
                  of: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
                  options: .regularExpression
              ) != nil else {
            return .invalid(version)
        }
        return .valid("\(packageName)@\(version)")
    }

    static func resolveDaemonPackageSpecifier(_ packageVersion: String?) -> String? {
        guard case let .valid(specifier) = daemonPackageVersionResolution(packageVersion) else {
            return nil
        }
        return specifier
    }

    static func resolveDaemonClientVersion(
        repoRoot: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String {
        let effectiveRepoRoot = resolveDaemonRepoRoot(repoRoot, environment: environment)
        return resolveDaemonClientVersion(
            repoRootHasBuiltEntry: resolveRepoRootDaemonEntryScript(effectiveRepoRoot) != nil,
            environment: environment
        )
    }

    /// The checkout used for both daemon launch and the matching client handshake. A caller may
    /// supply a root explicitly; otherwise XCTestRunner's own source checkout is used when built.
    static func resolveDaemonRepoRoot(
        _ repoRoot: String?,
        inferredRepoRoot: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String? {
        repoRoot
            ?? inferredRepoRoot
            ?? AutoMobileEnvironment(values: environment).firstNonEmpty(["AUTOMOBILE_REPO_ROOT"])
            ?? findRepoRoot(startingAt: #filePath)
    }

    static func resolveDaemonClientVersion(
        repoRootHasBuiltEntry: Bool,
        environment: [String: String]
    ) -> String {
        guard !repoRootHasBuiltEntry,
              let packageVersion = resolveDaemonPackageSpecifier(resolveDaemonPackageVersion(environment: environment))
        else {
            return AutoMobileVersion.current
        }
        return String(packageVersion.dropFirst(packageName.count + 1))
    }

    /// Finds the owning AutoMobile checkout for a runner source path. The caller still verifies the
    /// built entrypoint before using it, so package consumers without `dist/` retain PATH behavior.
    /// A package file alone is not enough: XCTestRunner may be vendored in a host JavaScript project.
    static func findRepoRoot(startingAt sourcePath: String) -> String? {
        var directory = URL(fileURLWithPath: sourcePath).deletingLastPathComponent()
        while directory.path != "/" {
            let packageURL = directory.appendingPathComponent("package.json")
            if let data = try? Data(contentsOf: packageURL),
               let package = try? JSONDecoder().decode(PackageMetadata.self, from: data),
               package.name == packageName
            {
                return directory.path
            }
            directory.deleteLastPathComponent()
        }
        return nil
    }

    /// Resolve the built daemon entrypoint under a caller-provided repo root, or nil when no root
    /// is given or the build is absent (so the caller falls back to the PATH `auto-mobile`).
    static func resolveRepoRootDaemonEntryScript(_ repoRoot: String?) -> String? {
        guard let repoRoot = repoRoot, !repoRoot.isEmpty else {
            return nil
        }
        let entry = URL(fileURLWithPath: repoRoot)
            .appendingPathComponent("dist/src/index.js").path
        return FileManager.default.fileExists(atPath: entry) ? entry : nil
    }
}
