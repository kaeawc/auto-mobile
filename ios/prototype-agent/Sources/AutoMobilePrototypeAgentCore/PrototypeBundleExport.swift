import Foundation

struct PrototypeBundleExportInput {
    let spec: Data
    let assets: (String) throws -> PrototypeBundleAsset?
    let fonts: (String) throws -> PrototypeBundleAsset?
}

extension PrototypeBundle {
    static func export(_ input: PrototypeBundleExportInput) throws -> Data {
        let bytes = try PrototypeBundleZipWriter.write(canonicalFiles(input))
        try bundleRequire(bytes.count <= maxCompressedBytes, .archiveTooLarge)
        return bytes
    }

    /// Shared with commit so even caller-constructed bundles are revalidated before disk writes.
    static func canonicalFiles(_ input: PrototypeBundleExportInput, requires: [String]? = nil) throws -> [(
        String,
        Data
    )] {
        try bundleRequire(input.spec.count <= maxSpecBytes, .entryTooLarge, "spec.json")
        let references = try PrototypeBundleReferences(input.spec)
        var files: [String: Data] = [:]
        let assets = try collect(references.images, lookup: input.assets, font: false, files: &files)
        let fonts = try collect(references.fonts, lookup: input.fonts, font: true, files: &files)
        try bundleRequire(
            Set(references.images).isDisjoint(with: references.fonts),
            .manifestInvalid,
            references.fonts.first(where: { references.images.contains($0) })?.string
        )
        let required: [String]
        if let requires { required = requires }
        else { required = try PrototypeBundleCapabilities.required(input.spec) }
        let manifest = try "{\"bundleFormatVersion\":1,\"specSha256\":\(quoted(sha256(input.spec)))," +
            "\"assets\":[\(assets.joined(separator: ","))],\"fonts\":[\(fonts.joined(separator: ","))]," +
            "\"requires\":[\(required.map(quoted).joined(separator: ","))]}"
        let bytes = Data(manifest.utf8)
        try bundleRequire(bytes.count <= maxManifestBytes, .entryTooLarge, "bundle.json")
        _ = try PrototypeBundleManifest(bytes)
        let result = [("bundle.json", bytes), ("spec.json", input.spec)] + files.keys.sorted().compactMap { path in
            files[path].map { (path, $0) }
        }
        try bundleRequire(result.count <= maxEntries, .tooManyEntries)
        try bundleRequire(result.reduce(0) { $0 + $1.1.count } <= maxExpandedBytes, .expandedTooLarge)
        return result
    }

    private static func collect(
        _ ids: [PrototypeBundleID], lookup: (String) throws -> PrototypeBundleAsset?, font: Bool,
        files: inout [String: Data]
    )
        throws -> [String]
    {
        try ids.sorted { $0.string.utf16.lexicographicallyPrecedes($1.string.utf16) }.map { id in
            let asset: PrototypeBundleAsset?
            do { asset = try lookup(id.string) }
            catch { throw PrototypeBundleFailure(.assetMissing) }
            guard let asset else { throw PrototypeBundleFailure(.assetMissing, id.string) }
            if asset.mediaType == PrototypeCustomShaders.mimeType { throw PrototypeBundleFailure(
                .customShadersUnsupported,
                id.string
            ) }
            try bundleRequire(PrototypeBundleManifest.validID(id.string), .manifestInvalid, id.string)
            try bundleRequire(
                asset.mediaType.hasPrefix("font/") == font &&
                    PrototypeBundleManifest.typeMatches(asset.mediaType, asset.bytes),
                .assetTypeMismatch,
                id.string
            )
            let cap = font ? assetLimits.maxFontBytes : assetLimits.maxImageBytes
            try bundleRequire(asset.bytes.count <= cap, .entryTooLarge, id.string)
            let hash = asset.sha256
            let path = PrototypeBundleManifest.file(type: asset.mediaType, hash: hash)
            files[path] = asset.bytes
            return try "{\"id\":\(quoted(id.string)),\"file\":\(quoted(path)),\"sha256\":\(quoted(hash))," +
                "\"mediaType\":\(quoted(asset.mediaType))}"
        }
    }

    /// Fixed field order is explicit above; Foundation handles JSON string escaping only.
    static func quoted(_ string: String) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return try String(decoding: encoder.encode(string), as: UTF8.self)
    }
}
