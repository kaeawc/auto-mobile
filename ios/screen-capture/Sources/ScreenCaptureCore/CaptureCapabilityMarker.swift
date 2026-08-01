import Foundation

/// A capability the helper advertises to the TypeScript supervisor at startup,
/// so a version skew is detectable before the encode path is chosen (issue
/// #4787). The token is stable wire vocabulary — the TS side matches it exactly.
public enum CaptureCapability: String, CaseIterable {
    /// In-helper H.264 encoding (the encoded-video record kind). The encoder
    /// itself lands in the follow-up (#4788); this build only advertises the
    /// vocabulary so the pairing can be validated ahead of time.
    case encodedVideoH264 = "encoded-video-h264"
}

/// Formats a {@link CaptureCapability} into a stable, greppable stderr line the
/// TS `IOSScreenCaptureHelper` parses. One token per line:
///
///     capture-capability: encoded-video-h264
///
/// Deliberately free of the `error:` prefix and the `no frames received` token
/// so the supervisor never misclassifies the handshake as a fatal error or a
/// permission denial (mirrors `CaptureStartupMarker`).
public enum CaptureCapabilityMarker {
    public static let prefix = "capture-capability:"

    public static func line(_ capability: CaptureCapability) -> String {
        "\(prefix) \(capability.rawValue)"
    }

    /// One handshake line per advertised capability, emitted at startup.
    public static func allLines() -> [String] {
        CaptureCapability.allCases.map(line)
    }
}
