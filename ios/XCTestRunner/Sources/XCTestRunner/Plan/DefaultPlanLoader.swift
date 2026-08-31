import Foundation

/// Resolves a plan path from an absolute/relative filesystem path, a test bundle, the main bundle, or
/// the current working directory. Stateless value type → `Sendable`.
public struct DefaultPlanLoader: AutoMobilePlanLoading {
    public init() {}

    public func loadPlan(at path: String, bundle: Bundle?) throws -> String {
        if let direct = resolveDirectPath(path) {
            return try readFile(at: direct)
        }

        if let bundle = bundle {
            if let resourceURL = bundle.url(forResource: path, withExtension: nil) {
                return try readFile(at: resourceURL)
            }
            if let resourceURL = resolveBundleResource(path: path, bundle: bundle) {
                return try readFile(at: resourceURL)
            }
            if let fallbackURL = resolveBundleFallback(path: path, bundle: bundle) {
                return try readFile(at: fallbackURL)
            }
        }

        if let mainURL = Bundle.main.url(forResource: path, withExtension: nil) {
            return try readFile(at: mainURL)
        }

        let cwdURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let relativeURL = cwdURL.appendingPathComponent(path)
        if FileManager.default.fileExists(atPath: relativeURL.path) {
            return try readFile(at: relativeURL)
        }

        throw PlanLoaderError.notFound(path)
    }

    private func resolveDirectPath(_ path: String) -> URL? {
        let url = URL(fileURLWithPath: path)
        if url.path.hasPrefix("/"), FileManager.default.fileExists(atPath: url.path) {
            return url
        }
        if FileManager.default.fileExists(atPath: url.path) {
            return url
        }
        return nil
    }

    private func resolveBundleResource(path: String, bundle: Bundle) -> URL? {
        let parts = path.split(separator: ".")
        if parts.count >= 2 {
            let name = parts.dropLast().joined(separator: ".")
            let ext = String(parts.last ?? "")
            return bundle.url(forResource: name, withExtension: ext)
        }
        return nil
    }

    private func resolveBundleFallback(path: String, bundle: Bundle) -> URL? {
        guard path.contains("/") else {
            return nil
        }
        let filename = URL(fileURLWithPath: path).lastPathComponent
        if let resourceURL = bundle.url(forResource: filename, withExtension: nil) {
            return resourceURL
        }
        return resolveBundleResource(path: filename, bundle: bundle)
    }

    private func readFile(at url: URL) throws -> String {
        do {
            return try String(contentsOf: url, encoding: .utf8)
        } catch {
            throw PlanLoaderError.unreadable(url.path)
        }
    }
}
