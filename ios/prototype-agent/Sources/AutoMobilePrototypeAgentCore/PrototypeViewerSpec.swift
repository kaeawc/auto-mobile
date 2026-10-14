import Foundation

protocol PrototypeViewerFileReading {
    /// Nil means the file is absent. An existing unreadable file must not select the fallback.
    func read(path: String) -> Data?
}

struct PrototypeViewerFileReader: PrototypeViewerFileReading {
    private let fileManager: FileManager

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    func read(path: String) -> Data? {
        guard fileManager.fileExists(atPath: path) else { return nil }
        // The narrow reader contract has no error case. Empty data makes an unreadable saved
        // file visibly invalid rather than silently falling back to a bundled prototype.
        return fileManager.contents(atPath: path) ?? Data()
    }
}

enum PrototypeViewerContent {
    case none
    case invalid(path: String, message: String)
    case loaded(PrototypeSpec, specBytes: Int)
}

struct PrototypeViewerSpecLoader {
    static let documentsFileName = "prototype.json"
    private let reader: any PrototypeViewerFileReading
    private let locations: [String]

    init(reader: any PrototypeViewerFileReading, locations: [String]) {
        self.reader = reader
        self.locations = locations
    }

    func load() -> PrototypeViewerContent {
        for location in locations {
            guard let data = reader.read(path: location) else { continue }
            guard data.count <= PrototypeLimits.maxSpecBytes else {
                return .invalid(path: "$", message: "Spec byte limit exceeded")
            }
            guard !data.isEmpty,
                  !String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else {
                return .invalid(path: "$", message: "Prototype file is empty; expected JSON")
            }
            do {
                let spec = try JSONDecoder().decode(PrototypeSpec.self, from: data)
                if let path = spec.root.unresolvedAnchorPath() {
                    return .invalid(path: path, message: "Element anchors must be resolved to bounds by the host")
                }
                return .loaded(spec, specBytes: data.count)
            } catch let error as DecodingError {
                return Self.invalid(error)
            } catch {
                return .invalid(path: "$", message: error.localizedDescription)
            }
        }
        return .none
    }

    private static func invalid(_ error: DecodingError) -> PrototypeViewerContent {
        let context: DecodingError.Context
        var missingKey: (any CodingKey)?
        switch error {
        case let .dataCorrupted(value), let .typeMismatch(_, value), let .valueNotFound(_, value):
            context = value
        case let .keyNotFound(key, value):
            context = value
            missingKey = key
        @unknown default:
            return .invalid(path: "$", message: "Invalid prototype JSON")
        }
        // Limits and theme validation already spell their path as `root.children[0]: message`.
        if context.codingPath.isEmpty,
           let separator = context.debugDescription.range(of: ": "),
           ["root", "data", "window", "theme"].contains(where: { context.debugDescription.hasPrefix($0) })
        {
            return .invalid(
                path: String(context.debugDescription[..<separator.lowerBound]),
                message: String(context.debugDescription[separator.upperBound...])
            )
        }
        var keys = context.codingPath
        if let missingKey { keys.append(missingKey) }
        var path = ""
        for key in keys {
            if let index = key.intValue {
                path += "[\(index)]"
            } else {
                path += (path.isEmpty ? "" : ".") + key.stringValue
            }
        }
        return .invalid(path: path.isEmpty ? "$" : path, message: context.debugDescription)
    }
}
