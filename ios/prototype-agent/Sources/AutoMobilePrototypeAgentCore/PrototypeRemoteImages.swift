import Foundation

/// URL-image contract only; loaders enforce development flavor and redirect policy.
public enum PrototypeRemoteImages {
    public static let capability = "prototype_remote_image_v1"
    public static let maxURLLength = 2048
    public static let maxDownloadBytes = 8_388_608
    public static let androidHeapDivisor = 8
    public static let maxIOSMemoryBytes = 67_108_864
    /// Longest decoded edge in pixels; larger sources are downsampled while decoding.
    static let maxDecodedEdge = 2048
    public static let maxDiskBytes = 134_217_728
    public static let maxLoads = 6

    static func validate(nodes: [PrototypeLocatedValue], state: [String: JSONValue]) throws {
        for entry in nodes where entry.value["type"] == .string("image") {
            let node = entry.value
            let path = entry.path
            if (node["asset"] != nil) == (node["url"] != nil) {
                throw PrototypeLimits.violation(path, "image requires exactly one of asset or url")
            }
            guard let url = node["url"]?.stringValue else { continue }
            if PrototypeDataText.stateKeys(url).contains(where: { $0 != "index" && state[$0] == nil }) {
                throw PrototypeLimits.violation("\(path).url", "Remote image URL references an undeclared state key")
            }
            if node["via"] == .string("host"), url.contains("{") {
                throw PrototypeLimits.violation("\(path).via", "Host remote images require a static URL")
            }
            if url.range(of: #"\{[^{}]+\}"#, options: .regularExpression) == url.startIndex ..< url
                .endIndex { continue }
            try PrototypeRequestValidator.url(node["url"], path: "\(path).url")
            let lower = url.lowercased()
            let scheme = lower.hasPrefix("https://") ? "https://" : "http://"
            let authority = url.dropFirst(scheme.count).prefix { !"/?#".contains($0) }
            let unsafe = url.unicodeScalars
                .contains {
                    PrototypeContractValidator.matches("blankText", String($0)) || $0.value <= 31 || (127 ... 159)
                        .contains($0.value) || $0 == "\\"
                }
            let loopback = lower.range(
                of: #"^http://(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)"#,
                options: .regularExpression
            ) != nil
            if authority.isEmpty || authority.hasPrefix(":") || authority
                .contains(where: { "@\\".contains($0) }) || unsafe || (lower.hasPrefix("http:") && !loopback)
            {
                throw PrototypeLimits.violation(
                    "\(path).url",
                    "Remote image URL requires HTTPS or literal loopback HTTP, without credentials, whitespace or backslashes"
                )
            }
        }
    }
}
