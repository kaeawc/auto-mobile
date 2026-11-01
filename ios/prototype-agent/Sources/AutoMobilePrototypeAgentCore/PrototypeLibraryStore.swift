import Foundation

struct PrototypeLibraryListing {
    let entries: [PrototypeLibraryEntry]
    let skippedCount: Int
}

struct PrototypeLibraryContent {
    let bundle: PrototypeBundle
    var spec: Data { bundle.spec }
    let assets: PrototypeAssets
    let entry: PrototypeLibraryEntry
}

/// Synchronous operations are serialized by the app. Storage never lives in the exportable library.
final class PrototypeLibraryStore {
    static let maxEntries = 200
    static let maxBytes = 100 * 1024 * 1024
    let root: URL
    private let storageRoot: URL
    private let files: any PrototypeLibraryFileSystem
    private let clock: any PrototypeClock
    private let libraryId: () -> String

    init(
        root: URL, storageRoot: URL,
        files: any PrototypeLibraryFileSystem = PrototypeLibraryDiskFileSystem(),
        clock: any PrototypeClock = SystemPrototypeClock(),
        libraryId: @escaping () -> String = { UUID().uuidString.lowercased() }
    )
        throws
    {
        self.root = root.standardizedFileURL
        self.storageRoot = storageRoot.standardizedFileURL
        self.files = files
        self.clock = clock
        self.libraryId = libraryId
        guard !self.storageRoot.path.hasPrefix(self.root.path + "/"),
              !self.root.path.hasPrefix(self.storageRoot.path + "/"), self.storageRoot != self.root
        else {
            throw PrototypeLibraryFailure(path: "storage", message: "Storage must be outside the library")
        }
        for directory in [self.root, self.storageRoot] {
            try files.createDirectory(directory)
            try files.excludeFromBackup(directory)
        }
    }

    func list() throws -> PrototypeLibraryListing {
        let children = try files.children(root)
        var entries: [PrototypeLibraryEntry] = []
        var skipped = 0
        var total = 0
        for child in children.sorted() {
            do {
                let directory = try directory(child)
                try files.assertRealDirectory(directory)
                let entry = try metadata(child)
                let bytes = try files.byteCount(directory)
                guard bytes <= Self.maxBytes - total else {
                    skipped += 1
                    continue
                }
                total += bytes
                entries.append(entry)
            } catch {
                // Corrupt/unreadable entries are deliberately isolated from the rest of the library.
                skipped += 1
            }
        }
        entries.sort {
            if $0.lastOpenedAt != $1.lastOpenedAt { return $0.lastOpenedAt > $1.lastOpenedAt }
            if $0.importedAt != $1.importedAt { return $0.importedAt > $1.importedAt }
            return $0.libraryId < $1.libraryId
        }
        skipped += max(0, entries.count - Self.maxEntries)
        return PrototypeLibraryListing(entries: Array(entries.prefix(Self.maxEntries)), skippedCount: skipped)
    }

    func load(_ libraryId: String) throws -> PrototypeLibraryContent {
        let directory = try directory(libraryId)
        guard let entry = try list().entries.first(where: { $0.libraryId == libraryId }) else {
            throw PrototypeLibraryFailure(path: libraryId, message: "Entry unavailable or library limit exceeded")
        }
        switch PrototypeSavedLayoutReader(files: files).load(directory: directory) {
        case let .loaded(layout):
            guard PrototypeBundle.sha256(layout.specData) == entry.specSha256 else {
                throw PrototypeLibraryFailure(path: "spec.json", message: "SHA-256 differs from library metadata")
            }
            try validate(layout.specData)
            if let problem = layout.problems.first {
                throw PrototypeLibraryFailure(path: problem.assetId, message: problem.description)
            }
            // The SavedLayout reader intentionally permits placeholders for the MCP template.
            // Library presentations additionally require every authored image/font reference.
            do {
                _ = try PrototypeBundle.canonicalFiles(.init(
                    spec: layout.specData,
                    assets: { id in
                        layout.assets[id].map { PrototypeBundleAsset(mediaType: $0.mediaType, bytes: $0.data) }
                    },
                    fonts: { id in
                        layout.assets[id].map { PrototypeBundleAsset(mediaType: $0.mediaType, bytes: $0.data) }
                    }
                ))
            } catch let failure as PrototypeBundleFailure {
                throw PrototypeLibraryFailure(path: failure.path ?? "manifest.json", message: failure.code.rawValue)
            } catch { throw PrototypeLibraryFailure(path: "manifest.json", message: error.localizedDescription) }
            return PrototypeLibraryContent(
                bundle: PrototypeBundle(
                    spec: layout.specData,
                    assets: Dictionary(uniqueKeysWithValues: layout.assets.values.filter { !$0.isFont }.map {
                        (PrototypeBundleID($0.id), PrototypeBundleAsset(mediaType: $0.mediaType, bytes: $0.data))
                    }),
                    fonts: Dictionary(uniqueKeysWithValues: layout.assets.values.filter(\.isFont).map {
                        (PrototypeBundleID($0.id), PrototypeBundleAsset(mediaType: $0.mediaType, bytes: $0.data))
                    }), requires: entry.requires
                ),
                assets: PrototypeAssets(
                    images: layout.assets.filter { !$0.value.isFont }.mapValues(\.data),
                    fonts: layout.assets.filter { $0.value.isFont }.mapValues(\.data)
                ), entry: entry
            )
        case let .corrupt(message): throw PrototypeLibraryFailure(path: "manifest.json", message: message)
        case let .unsupportedFormat(version):
            throw PrototypeLibraryFailure(
                path: "manifest.json.formatVersion",
                message: "Unsupported version \(version)"
            )
        case .notFound: throw PrototypeLibraryFailure(path: libraryId, message: "Saved layout is missing")
        }
    }

    func markOpened(_ libraryId: String, now: Int? = nil) throws {
        var entry = try metadata(libraryId)
        entry.lastOpenedAt = now ?? clock.nowMilliseconds
        let bytes = try entry.encoded()
        _ = try PrototypeLibraryEntry.decode(bytes)
        try files.writeAtomic(directory(libraryId).appendingPathComponent("library.json"), bytes: bytes)
    }

    func storageURL(_ libraryId: String) throws -> URL {
        try PrototypeLibraryEntry.validateId(libraryId)
        let url = storageRoot.appendingPathComponent(libraryId, isDirectory: true)
        try files.createDirectory(url)
        try files.excludeFromBackup(url)
        return url
    }

    func resetStorage(_ libraryId: String) throws {
        try PrototypeLibraryEntry.validateId(libraryId)
        let url = storageRoot.appendingPathComponent(libraryId, isDirectory: true)
        if files.exists(url) { try files.remove(url) }
    }

    func delete(_ libraryId: String) throws {
        let prototype = try directory(libraryId)
        let storage = storageRoot.appendingPathComponent(libraryId, isDirectory: true)
        // Attempt both removals even if one fails, and report every failed path.
        var failures: [String] = []
        for path in [prototype, storage] where files.exists(path) {
            do { try files.remove(path) }
            catch { failures.append("\(path.path): \(error.localizedDescription)") }
        }
        if !failures.isEmpty {
            throw PrototypeLibraryFailure(path: libraryId, message: failures.joined(separator: "; "))
        }
    }

    /// Internal commit seam: callers supply provenance, never read it from imported bundle metadata.
    @discardableResult
    func add(
        _ bundle: PrototypeBundle,
        label: String,
        source: PrototypeLibraryEntry.Source
    )
        throws -> PrototypeLibraryEntry
    {
        let id = libraryId()
        let destination = try directory(id)
        try validate(bundle.spec)
        let canonical = try PrototypeBundle.canonicalFiles(.init(
            spec: bundle.spec, assets: { bundle.assets[PrototypeBundleID($0)] },
            fonts: { bundle.fonts[PrototypeBundleID($0)] }
        ), requires: bundle.requires)
        let entry = PrototypeLibraryEntry(
            libraryId: id, label: label, importedAt: clock.nowMilliseconds, lastOpenedAt: clock.nowMilliseconds,
            source: source, specSha256: bundle.specSha256, requires: bundle.requires, pinned: false
        )
        let metadata = try entry.encoded()
        _ = try PrototypeLibraryEntry.decode(metadata)
        guard let transport = canonical.first(where: { $0.0 == "bundle.json" }) else {
            throw PrototypeLibraryFailure(path: "manifest.json", message: "Missing canonical manifest")
        }
        var manifest = try JSONDecoder().decode([String: JSONValue].self, from: transport.1)
        manifest.removeValue(forKey: "bundleFormatVersion")
        manifest.removeValue(forKey: "specSha256")
        manifest.removeValue(forKey: "requires")
        manifest["formatVersion"] = .number(Double(PrototypeSavedLayout.formatVersion))
        manifest["specFile"] = .string("spec.json")
        var output = canonical.filter { $0.0 != "bundle.json" }
        try output.append(("manifest.json", JSONEncoder().encode(manifest)))
        output.append(("library.json", metadata))
        let bytes = output.reduce(0) { $0 + $1.1.count }
        guard try files.children(root).count < Self.maxEntries,
              try files.byteCount(root) <= Self.maxBytes - bytes
        else {
            throw PrototypeLibraryFailure(path: "library", message: "Library capacity exceeded")
        }
        try files.assertAbsent(destination)
        // Orphaned values from an earlier partial deletion cannot become a new import's storage.
        try files.assertAbsent(storageRoot.appendingPathComponent(id, isDirectory: true))
        let stage = try files.makeStagingDirectory(parent: root, mode: 0o700)
        do {
            try files.excludeFromBackup(stage)
            for folder in ["assets", "fonts"] { try files.mkdir(stage.appendingPathComponent(folder), mode: 0o700) }
            for (path, data) in output {
                try files.writeExclusiveNoFollow(
                    stage.appendingPathComponent(path),
                    bytes: data
                )
            }
            try files.rename(from: stage, to: destination)
        } catch {
            let original = error.localizedDescription
            do { try files.remove(stage) }
            catch { throw PrototypeLibraryFailure(
                path: id,
                message: "\(original); cleanup failed: \(error.localizedDescription)"
            ) }
            throw PrototypeLibraryFailure(path: id, message: original)
        }
        return entry
    }

    private func directory(_ id: String) throws -> URL {
        try PrototypeLibraryEntry.validateId(id)
        return root.appendingPathComponent(id, isDirectory: true)
    }

    private func metadata(_ id: String) throws -> PrototypeLibraryEntry {
        let directory = try directory(id)
        try files.assertRealDirectory(directory)
        let entry = try PrototypeLibraryEntry.decode(files.read(
            directory.appendingPathComponent("library.json"),
            cap: 65536
        ))
        guard entry.libraryId == id else {
            throw PrototypeLibraryFailure(
                path: "library.json.libraryId",
                message: "Directory and metadata identity differ"
            )
        }
        return entry
    }

    func validate(
        _ bytes: Data, supportedCapabilities: Set<String> = Set(AutoMobilePrototypeCapabilities.supported)
    )
        throws
    {
        do {
            try PrototypeSpecStrictValidator.validate(data: bytes, library: true)
            let (value, _) = try PrototypeContractValidator.inspect(data: PrototypeStrictJSON.prepare(bytes))
            let missing = PrototypeStrictCapabilities.required(value.objectFields ?? [:])
                .subtracting(supportedCapabilities).sorted()
            if !missing.isEmpty { throw PrototypeLibraryImportFailure.needsNewerViewer(missing: missing) }
        } catch let failure as PrototypeLibraryImportFailure { throw failure }
        catch let failure as PrototypeLibraryFailure { throw failure }
        catch let PrototypeLoadError.invalidSpec(path, message) {
            throw PrototypeLibraryFailure(path: path, message: message)
        } catch { throw PrototypeLibraryFailure(path: "spec.json", message: error.localizedDescription) }
    }
}
