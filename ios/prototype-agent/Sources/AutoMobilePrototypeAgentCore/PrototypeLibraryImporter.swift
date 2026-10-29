import Foundation

enum PrototypeLibraryImportFailure: Error, Equatable, LocalizedError {
    case invalid(path: String, message: String)
    case needsNewerViewer(missing: [String])

    var path: String {
        switch self {
        case let .invalid(path, _): path
        case .needsNewerViewer: "$"
        }
    }

    var message: String {
        switch self {
        case let .invalid(_, message): message
        case let .needsNewerViewer(missing): "Needs a newer ProtoViewer: \(missing.joined(separator: ", "))"
        }
    }

    var errorDescription: String? { "\(path): \(message)" }
}

struct PrototypeLibraryImporter {
    enum Source: String, Sendable { case mcp, file, share, paste }
    static let maxImagePixels = 16_000_000
    static let maxTotalImagePixels = 64_000_000
    let store: PrototypeLibraryStore
    var imageProbe: any ImageHeaderProbe = PrototypeLibraryImageIOProbe()
    var supportedCapabilities = Set(AutoMobilePrototypeCapabilities.supported)

    /// Bytes alone choose the format; provenance is chosen by the app's receiving route.
    @discardableResult
    func importData(_ bytes: Data, source: Source, label: String? = nil) throws -> PrototypeLibraryEntry {
        do {
            let zip = Self.isZIP(bytes)
            let cap = zip ? PrototypeBundle.maxCompressedBytes : PrototypeBundle.maxSpecBytes
            guard bytes.count <= cap else {
                throw PrototypeLibraryImportFailure.invalid(path: "$", message: "Import byte cap exceeded")
            }
            let bundle: PrototypeBundle
            if zip {
                bundle = try readBundle(bytes)
                try store.validate(bundle.spec, supportedCapabilities: supportedCapabilities)
            } else {
                let spec = try PrototypeStrictJSON.prepare(bytes)
                try store.validate(spec, supportedCapabilities: supportedCapabilities)
                // Reuse transport reference completeness, including font references.
                _ = try PrototypeBundle.canonicalFiles(.init(spec: spec, assets: { _ in nil }, fonts: { _ in nil }))
                bundle = try PrototypeBundle(
                    spec: spec, assets: [:], fonts: [:], requires: PrototypeBundleCapabilities.required(spec)
                )
            }
            try checkImages(bundle)
            // A timed-out host may retry with a new request id. Preserve the original entry and
            // label for the same spec, after validating the incoming bundle in full.
            let digest = bundle.specSha256
            if let existing = try store.list().entries.first(where: { $0.specSha256 == digest }) {
                return existing
            }
            let fields = try JSONDecoder().decode(
                [String: JSONValue].self,
                from: PrototypeStrictJSON.prepare(bundle.spec)
            )
            let label = label ?? fields["id"]?.stringValue ?? fields["window"]?.objectFields?["title"]?.stringValue
                ?? "Imported prototype"
            let provenance: PrototypeLibraryEntry.Source
            switch source {
            case .mcp: provenance = .mcp
            case .file: provenance = .file
            case .share: provenance = .share
            case .paste: provenance = .paste
            }
            return try store.add(bundle, label: label, source: provenance)
        } catch let error as PrototypeLibraryImportFailure { throw error }
        catch let error as PrototypeLibraryFailure {
            throw PrototypeLibraryImportFailure.invalid(path: error.path, message: error.message)
        } catch let error as PrototypeBundleFailure {
            throw PrototypeLibraryImportFailure.invalid(path: error.path ?? "$", message: error.code.rawValue)
        } catch let PrototypeLoadError.invalidSpec(path, message) {
            throw PrototypeLibraryImportFailure.invalid(path: path, message: message)
        } catch {
            throw PrototypeLibraryImportFailure.invalid(path: "$", message: error.localizedDescription)
        }
    }

    static func isZIP(_ bytes: Data) -> Bool {
        // Includes empty/spanned ZIP signatures so malformed ZIPs still use the strict reader.
        let signatures: [[UInt8]] = [[80, 75, 3, 4], [80, 75, 5, 6], [80, 75, 7, 8]]
        return signatures.contains { bytes.starts(with: $0) }
    }

    private func readBundle(_ bytes: Data) throws -> PrototypeBundle {
        do { return try PrototypeBundle.read(bytes) }
        catch let failure as PrototypeBundleFailure where failure.code == .specInvalid {
            // The transport reports spec_invalid at spec.json. Recover the strict validator's
            // authored path for the app alert, only after the strict ZIP reader has accepted it.
            let entries = try PrototypeBundleZipReader.read(bytes)
            if let spec = entries.first(where: { $0.0 == "spec.json" })?.1 {
                try store.validate(spec, supportedCapabilities: supportedCapabilities)
            }
            throw failure
        }
    }

    private func checkImages(_ bundle: PrototypeBundle) throws {
        var total = 0
        for (id, asset) in bundle.assets.sorted(by: { $0.key.string < $1.key.string }) {
            let path = "assets/\(id.string)"
            guard ["image/png", "image/jpeg", "image/webp"].contains(asset.mediaType),
                  PrototypeBundleManifest.typeMatches(asset.mediaType, asset.bytes)
            else {
                throw PrototypeLibraryImportFailure.invalid(path: path, message: "Unsupported image magic bytes")
            }
            let size: PrototypeLibraryImageSize
            do { size = try imageProbe.dimensions(asset.bytes) }
            catch {
                throw PrototypeLibraryImportFailure.invalid(path: path, message: "Unreadable image header")
            }
            guard size.width > 0, size.height > 0, size.width <= Self.maxImagePixels,
                  size.height <= Self.maxImagePixels / size.width
            else {
                throw PrototypeLibraryImportFailure.invalid(path: path, message: "Image pixel budget exceeded")
            }
            let pixels = size.width * size.height
            guard total <= Self.maxTotalImagePixels - pixels else {
                throw PrototypeLibraryImportFailure.invalid(path: path, message: "Total image pixel budget exceeded")
            }
            total += pixels
        }
    }
}
