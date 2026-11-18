import Foundation

/// Original encoded asset bytes only. IDs are dictionary keys, never filesystem paths.
protocol PrototypeUploadAssetSource {
    func data(for id: String) -> Data?
}

struct PrototypeUploadAssets: PrototypeUploadAssetSource {
    var bytes: [String: Data] = [:]
    func data(for id: String) -> Data? { bytes[id] }
}

/// The sole multipart boundary primitive; tests supply a fixed boundary.
protocol PrototypeUploadBoundaryGenerating {
    func nextBoundary() -> String
}

struct PrototypeUploadBoundaryGenerator: PrototypeUploadBoundaryGenerating {
    func nextBoundary() -> String { UUID().uuidString }
}

struct PrototypeUploadBody: Equatable, Sendable {
    let data: Data
    let contentType: String
    /// File payload bytes only, excluding multipart framing and text fields.
    let fileBytes: Int
}

enum PrototypeUploadResolver {
    static let hostRefusal = PrototypeRequestError(
        .invalidRequest, "Host uploads are not available until host chunk frames land; use via \"device\"."
    )

    static func isUpload(_ body: JSONValue?) -> Bool {
        body?.objectFields?.keys.contains { ["multipart", "form", "file"].contains($0) } == true
    }

    static func resolve(
        _ body: JSONValue, inputs: some PrototypeEmitContextInputs,
        assets: (any PrototypeUploadAssetSource)?, boundary: any PrototypeUploadBoundaryGenerating
    )
        throws -> PrototypeUploadBody
    {
        guard let fields = body.objectFields else { throw invalid("Expected an upload body") }
        if let entries = fields["form"]?.objectFields {
            let encoded = try entries.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.map { key in
                try PrototypeRequestURL.formComponent(key) + "=" +
                    PrototypeRequestURL.formComponent(text(entries[key], inputs: inputs))
            }.joined(separator: "&")
            return .init(data: Data(encoded.utf8), contentType: "application/x-www-form-urlencoded", fileBytes: 0)
        }
        if let file = fields["file"] {
            let bytes = try asset(file, assets: assets)
            try checkSize(bytes.count)
            return .init(
                data: bytes, contentType: fields["contentType"]?.stringValue ?? "application/octet-stream",
                fileBytes: bytes.count
            )
        }
        guard case let .array(parts)? = fields["multipart"] else { throw invalid("Expected multipart parts") }
        let token = boundary.nextBoundary()
        guard !token.isEmpty, token.utf8.allSatisfy({
            (48 ... 57).contains($0) || (65 ... 90).contains($0) || (97 ... 122).contains($0) || $0 == 45
        }) else { throw invalid("Invalid multipart boundary") }
        var data = Data()
        var fileBytes = 0
        for raw in parts {
            guard let part = raw.objectFields, let name = part["name"]?.stringValue else {
                throw invalid("Invalid multipart part")
            }
            let bytes: Data
            var filename = part["filename"]?.stringValue
            var contentType = part["contentType"]?.stringValue
            if let file = part["file"] {
                bytes = try asset(file, assets: assets)
                fileBytes += bytes.count
                try checkSize(fileBytes)
                filename = filename ?? file.objectFields?["asset"]?.stringValue
                contentType = contentType ?? "application/octet-stream"
            } else {
                bytes = try Data(text(part["value"], inputs: inputs).utf8)
            }
            var header = "--\(token)\r\nContent-Disposition: form-data; name=\"\(quoted(name))\""
            if let filename { header += "; filename=\"\(quoted(filename))\"" }
            header += "\r\n"
            if let contentType {
                guard !contentType.contains("\r"), !contentType.contains("\n") else {
                    throw invalid("Invalid upload content type")
                }
                header += "Content-Type: \(contentType)\r\n"
            }
            data.append(Data((header + "\r\n").utf8))
            data.append(bytes)
            data.append(Data("\r\n".utf8))
        }
        data.append(Data("--\(token)--\r\n".utf8))
        return .init(data: data, contentType: "multipart/form-data; boundary=\(token)", fileBytes: fileBytes)
    }

    private static func text(_ binding: JSONValue?, inputs: some PrototypeEmitContextInputs) throws -> String {
        guard let binding else { throw invalid("Missing upload value binding") }
        switch PrototypeDataWrite.resolveValue(binding, inputs: inputs) {
        case let .success(value):
            if case let .string(text) = value { return text }
            return PrototypeJSONText.string(value)
        case let .failure(error): throw invalid(error.message)
        }
    }

    private static func asset(_ file: JSONValue, assets: (any PrototypeUploadAssetSource)?) throws -> Data {
        let id = file.objectFields?["asset"]?.stringValue ?? ""
        guard let bytes = assets?.data(for: id) else {
            throw invalid("Upload asset '\(id)' is missing; upload the asset again before requesting.")
        }
        return bytes
    }

    private static func checkSize(_ count: Int) throws {
        guard count <= PrototypeLimits.maxUploadBytes else {
            throw invalid("Upload file bytes exceed \(PrototypeLimits.maxUploadBytes); use smaller assets.")
        }
    }

    /// OkHttp's quoted form-data parameter escaping.
    private static func quoted(_ value: String) -> String {
        value.replacingOccurrences(of: "\n", with: "%0A").replacingOccurrences(of: "\r", with: "%0D")
            .replacingOccurrences(of: "\"", with: "%22")
    }

    private static func invalid(_ message: String) -> PrototypeRequestError { .init(.invalidRequest, message) }
}
