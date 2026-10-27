import Foundation

/// Incremental HTTP/1.1 framing, independent of sockets, clocks and DNS.
struct PrototypeHTTP1Codec {
    struct Response {
        let status: Int
        let headers: [String: String]
        let body: Data
    }

    private enum Framing { case headers, length(Int), eof, chunkSize, chunk(Int), trailers, done }
    private static let headerLimit = 64 * 1024
    private static let crlf = Data("\r\n".utf8)
    private static let separator = Data("\r\n\r\n".utf8)
    private static let token = Set("!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".utf8)
    private let method: PrototypeRequestMethod
    private let maxResponseBytes: Int
    private var framing = Framing.headers
    private var buffer = Data()
    private var body = Data()
    private var status = 0
    private var headers: [String: String] = [:]

    init(method: PrototypeRequestMethod, maxResponseBytes: Int) {
        self.method = method
        self.maxResponseBytes = maxResponseBytes
    }

    static func serialize(_ request: PrototypeHttpRequest, url: URL) throws -> Data {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: true), let host = url.host else {
            throw PrototypeRequestError(.invalidURL, "Not an absolute URL: \(request.url)")
        }
        let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        let target = path + (components.percentEncodedQuery.map { "?" + $0 } ?? "")
        let port = PrototypeRequestEgressCheck.port(url)
        let defaultPort = url.scheme?.lowercased() == "https" ? 443 : 80
        let unbracketed = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let hostname = unbracketed.contains(":") ? "[\(unbracketed)]" : unbracketed
        var lines = [
            "\(request.method.rawValue) \(target) HTTP/1.1",
            "Host: \(hostname)\(port == defaultPort ? "" : ":\(port)")",
        ]
        // The codec has no content decoder, so the wire request always negotiates identity.
        lines += request.headers.filter { $0.key.lowercased() != "accept-encoding" }
            .sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }
        lines += ["Connection: close", "Accept-Encoding: identity"]
        let body = request.method.allowsBody ? request.body : nil
        if let body { lines.append("Content-Length: \(body.count)") }
        var bytes = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
        if let body { bytes.append(body) }
        return bytes
    }

    mutating func append(_ bytes: Data, eof: Bool = false) throws -> Response? {
        buffer.append(bytes)
        while try advance() {}
        if eof {
            if case .eof = framing { framing = .done }
            guard case .done = framing else { throw Self.invalid }
        }
        guard case .done = framing else { return nil }
        return Response(status: status, headers: headers, body: body)
    }

    private mutating func advance() throws -> Bool {
        switch framing {
        case .headers: return try readHeaders()
        case let .length(count):
            let available = min(count, buffer.count)
            try appendBody(take(available))
            framing = available == count ? .done : .length(count - available)
            return false
        case .eof:
            try appendBody(take(buffer.count))
            return false
        case .chunkSize: return try readChunkSize()
        case let .chunk(count): return try readChunk(count)
        case .trailers: return try readTrailers()
        case .done: return false
        }
    }

    private mutating func readHeaders() throws -> Bool {
        guard let range = buffer.range(of: Self.separator) else {
            guard buffer.count <= Self.headerLimit else { throw Self.invalid }
            return false
        }
        let count = buffer.distance(from: buffer.startIndex, to: range.upperBound)
        guard count <= Self.headerLimit else { throw Self.invalid }
        let block = take(count)
        guard let text = String(data: block.dropLast(4), encoding: .utf8) else { throw Self.invalid }
        var lines = text.components(separatedBy: "\r\n")
        let line = lines.removeFirst().split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
        guard line.count >= 2, ["HTTP/1.1", "HTTP/1.0"].contains(line[0]),
              line[1].count == 3, line[1].utf8.allSatisfy({ (48 ... 57).contains($0) }),
              let code = Int(line[1]), (100 ... 599).contains(code) else { throw Self.invalid }
        let parsed = try Self.fields(lines)
        if code < 200 { return true }
        status = code
        headers = parsed
        if method == .head || code == 204 || code == 304 || !(200 ..< 300).contains(code) {
            framing = .done
            return false
        }
        try selectFraming()
        return true
    }

    private mutating func selectFraming() throws {
        if let encoding = headers["transfer-encoding"] {
            guard encoding.lowercased() == "chunked", headers["content-length"] == nil else { throw Self.invalid }
            framing = .chunkSize
        } else if let length = headers["content-length"] {
            guard !length.isEmpty, length.utf8.allSatisfy({ (48 ... 57).contains($0) }) else { throw Self.invalid }
            guard let count = Int(length), count <= maxResponseBytes else { throw tooLarge }
            framing = .length(count)
        } else {
            framing = .eof
        }
    }

    private mutating func readChunkSize() throws -> Bool {
        guard let range = buffer.range(of: Self.crlf) else {
            guard buffer.count <= Self.headerLimit else { throw Self.invalid }
            return false
        }
        let count = buffer.distance(from: buffer.startIndex, to: range.upperBound)
        guard count <= Self.headerLimit else { throw Self.invalid }
        guard let text = String(data: take(count).dropLast(2), encoding: .utf8) else { throw Self.invalid }
        let digits = text.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)[0]
        guard !digits.isEmpty, digits.utf8.allSatisfy({
            (48 ... 57).contains($0) || (65 ... 70).contains($0) || (97 ... 102).contains($0)
        }), let size = Int(digits, radix: 16) else { throw Self.invalid }
        guard size <= maxResponseBytes - body.count else { throw tooLarge }
        framing = size == 0 ? .trailers : .chunk(size)
        return true
    }

    private mutating func readChunk(_ remaining: Int) throws -> Bool {
        // Keep only the framing delimiter buffered; stream chunk payload through the same cap.
        let count = min(remaining, buffer.count)
        if !buffer.isEmpty, remaining > 0 {
            try appendBody(take(count))
            framing = .chunk(remaining - count)
            return true
        }
        guard remaining == 0, buffer.count >= 2 else { return false }
        guard take(2) == Self.crlf else { throw Self.invalid }
        framing = .chunkSize
        return true
    }

    private mutating func readTrailers() throws -> Bool {
        if buffer.starts(with: Self.crlf) {
            _ = take(2)
            framing = .done
            return false
        }
        guard let range = buffer.range(of: Self.separator) else {
            guard buffer.count <= Self.headerLimit else { throw Self.invalid }
            return false
        }
        let count = buffer.distance(from: buffer.startIndex, to: range.upperBound)
        guard count <= Self.headerLimit else { throw Self.invalid }
        guard let text = String(data: take(count).dropLast(4), encoding: .utf8) else { throw Self.invalid }
        _ = try Self.fields(text.components(separatedBy: "\r\n"))
        framing = .done
        return false
    }

    private static func fields(_ lines: [String]) throws -> [String: String] {
        try lines.reduce(into: [:]) { fields, line in
            guard let colon = line.firstIndex(of: ":") else { throw invalid }
            let name = line[..<colon]
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, name.utf8.allSatisfy({ token.contains($0) }),
                  !value.utf8.contains(where: { ($0 < 32 && $0 != 9) || $0 == 127 }) else { throw invalid }
            let key = name.lowercased()
            fields[key] = fields[key].map { $0 + ", " + value } ?? value
        }
    }

    private mutating func take(_ count: Int) -> Data {
        let bytes = Data(buffer.prefix(count))
        buffer.removeFirst(count)
        return bytes
    }

    private mutating func appendBody(_ bytes: Data) throws {
        guard bytes.count <= maxResponseBytes - body.count else { throw tooLarge }
        body.append(bytes)
    }

    private static var invalid: PrototypeRequestError { .init(.invalidResponse, "Malformed HTTP/1.1 response.") }
    private var tooLarge: PrototypeRequestError {
        .init(.tooLarge, "Response body exceeds \(maxResponseBytes) bytes.")
    }
}
