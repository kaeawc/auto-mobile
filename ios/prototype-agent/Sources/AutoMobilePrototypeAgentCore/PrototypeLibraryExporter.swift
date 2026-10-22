import Foundation

struct PrototypeLibraryExport: Identifiable {
    let url: URL
    let warnings: [PrototypeBundleSecretWarning]
    var id: URL { url }
}

/// A dedicated temporary root and injected file system keep cleanup separate from the library.
struct PrototypeLibraryExporter {
    let store: PrototypeLibraryStore
    var temporaryRoot = FileManager.default.temporaryDirectory.appendingPathComponent("ProtoViewer-exports")
    var files: any PrototypeLibraryFileSystem = PrototypeLibraryDiskFileSystem()

    func export(_ libraryId: String) throws -> PrototypeLibraryExport {
        let content = try store.load(libraryId)
        let bytes = try PrototypeBundle.export(.init(
            spec: content.spec,
            assets: { id in try Self.asset(content.assets.images[id], font: false, id: id) },
            fonts: { id in try Self.asset(content.assets.fonts[id], font: true, id: id) }
        ))
        try files.createDirectory(temporaryRoot)
        let directory = try files.makeStagingDirectory(parent: temporaryRoot, mode: 0o700)
        let url = directory.appendingPathComponent(Self.filename(content.entry.label))
        do {
            try files.writeExclusiveNoFollow(url, bytes: bytes)
            return PrototypeLibraryExport(url: url, warnings: PrototypeBundleSecrets.scan(content.spec))
        } catch {
            let original = error.localizedDescription
            do { try files.remove(directory) }
            catch {
                throw PrototypeLibraryFailure(
                    path: url.path, message: "\(original); cleanup failed: \(error.localizedDescription)"
                )
            }
            throw PrototypeLibraryFailure(path: url.path, message: original)
        }
    }

    /// Do not lose the only cleanup handle if replacement or removal fails.
    func prepareExport(_ libraryId: String, pending: inout PrototypeLibraryExport?) throws {
        if let previous = pending {
            try cleanup(previous)
            pending = nil
        }
        pending = try export(libraryId)
    }

    func cleanup(_ export: PrototypeLibraryExport) throws {
        let directory = export.url.deletingLastPathComponent().standardizedFileURL
        guard directory.deletingLastPathComponent().path == temporaryRoot.standardizedFileURL.path,
              directory.path != temporaryRoot.standardizedFileURL.path
        else {
            throw PrototypeLibraryFailure(path: export.url.path, message: "Export is outside temporary directory")
        }
        if files.exists(directory) { try files.remove(directory) }
    }

    func purgeStaleExports() throws {
        try files.createDirectory(temporaryRoot)
        for child in try files.children(temporaryRoot) {
            let path = temporaryRoot.appendingPathComponent(child)
            guard path.deletingLastPathComponent().standardizedFileURL.path == temporaryRoot.standardizedFileURL.path
            else {
                throw PrototypeLibraryFailure(path: child, message: "Invalid temporary path")
            }
            try files.remove(path)
        }
    }

    private static func filename(_ label: String) -> String {
        let safe = label.unicodeScalars.map { scalar -> String in
            scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar) || " -_".unicodeScalars.contains(scalar))
                ? String(scalar) : "_"
        }.joined().trimmingCharacters(in: .whitespaces)
        return "\(safe.isEmpty ? "Imported prototype" : String(safe.prefix(80))).automobile-proto"
    }

    private static func asset(_ bytes: Data?, font: Bool, id: String) throws -> PrototypeBundleAsset? {
        guard let bytes else { return nil }
        let types = font ? ["font/ttf", "font/otf"] : ["image/png", "image/jpeg", "image/webp"]
        guard let type = types.first(where: { PrototypeBundleManifest.typeMatches($0, bytes) }) else {
            throw PrototypeLibraryFailure(path: id, message: "Unsupported asset magic bytes")
        }
        return PrototypeBundleAsset(mediaType: type, bytes: bytes)
    }
}
