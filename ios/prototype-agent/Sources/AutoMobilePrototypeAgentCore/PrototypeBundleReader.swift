import Foundation

extension PrototypeBundle {
    static func read(_ bytes: Data) throws -> PrototypeBundle {
        let entries = try PrototypeBundleZipReader.read(bytes)
        let files = Dictionary(uniqueKeysWithValues: entries)
        guard let manifestData = files["bundle.json"] else {
            throw PrototypeBundleFailure(.manifestInvalid, "bundle.json")
        }
        let manifest = try PrototypeBundleManifest(manifestData)
        guard let spec = files["spec.json"] else { throw PrototypeBundleFailure(.specInvalidJSON, "spec.json") }
        try bundleRequire(sha256(spec) == manifest.specSha256, .specShaMismatch, "spec.json")
        let references = try PrototypeBundleReferences(spec)
        let assets = try assetMap(manifest.assets, files: files, references: references.images, font: false)
        let fonts = try assetMap(manifest.fonts, files: files, references: references.fonts, font: true)
        let listed = Set((manifest.assets + manifest.fonts).map(\.file))
        for (path, _) in entries {
            try bundleRequire(
                path == "bundle.json" || path == "spec.json" || listed.contains(path),
                .manifestEntryMissing,
                path
            )
        }
        return Self(spec: spec, assets: assets, fonts: fonts, requires: manifest.requires)
    }

    private static func assetMap(
        _ records: [PrototypeBundleManifest.Asset], files: [String: Data], references: [PrototypeBundleID], font: Bool
    )
        throws -> [PrototypeBundleID: PrototypeBundleAsset]
    {
        let referenced = Set(references)
        var result: [PrototypeBundleID: PrototypeBundleAsset] = [:]
        for record in records {
            guard let bytes = files[record.file]
            else { throw PrototypeBundleFailure(.manifestEntryMissing, record.file) }
            try bundleRequire(sha256(bytes) == record.sha256, .sha256Mismatch, record.file)
            try bundleRequire(
                PrototypeBundleManifest.typeMatches(record.mediaType, bytes),
                .assetTypeMismatch,
                record.file
            )
            try bundleRequire(referenced.contains(record.id), .unreferencedAsset, record.id.string)
            result[record.id] = PrototypeBundleAsset(mediaType: record.mediaType, bytes: bytes)
        }
        for id in references {
            try bundleRequire(result[id] != nil, font ? .fontMissing : .assetMissing, id.string)
        }
        return result
    }
}
