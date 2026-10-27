import Foundation

public let maxPrototypeClipboardTextBytes = 65536

@MainActor
public protocol PrototypeClipboard {
    func copy(text: String, sensitive: Bool, label: String?)
    func paste() async throws -> String
    var hasText: Bool { get }
}

public enum PrototypeClipboardError: Error { case permissionDenied }

@MainActor
public final class FakePrototypeClipboard: PrototypeClipboard {
    public var text: String
    public var denied = false
    public private(set) var platformCalls: [JSONValue] = []
    public private(set) var sensitive = false
    public private(set) var label: String?
    public init(text: String = "") { self.text = text }
    public func copy(text: String, sensitive: Bool, label: String?) {
        record("copy", bytes: text.utf8.count)
        self.text = text
        self.sensitive = sensitive
        self.label = label
    }

    public func paste() async throws -> String {
        record("paste", bytes: denied ? 0 : text.utf8.count)
        if denied { throw PrototypeClipboardError.permissionDenied }
        return text
    }

    public var hasText: Bool {
        record("hasText")
        return !text.isEmpty
    }

    private func record(_ op: String, bytes: Int = 0) {
        platformCalls.append(.object(["op": .string(op), "bytes": .number(Double(bytes))]))
    }
}

@MainActor
public final class PrototypeClipboardModule: PrototypePlatformModule {
    private let clipboard: any PrototypeClipboard
    public let name = "clipboard"
    public let capability = "prototype_platform_clipboard_v1"
    public var events: AsyncStream<PlatformEvent> { AsyncStream { $0.finish() } }
    public var state: [String: JSONValue] { [:] }
    public init(clipboard: any PrototypeClipboard) { self.clipboard = clipboard }
    public func availability() -> PlatformAvailability { .ready }
    public func call(_ call: PlatformCall) async -> PlatformCallResult {
        switch call.call {
        case "clipboard.copy":
            guard let text = call.args["text"]?.stringValue,
                  text.utf8.count <= maxPrototypeClipboardTextBytes
            else {
                return .failure(.invalidArgs, "Invalid clipboard text")
            }
            clipboard.copy(
                text: text,
                sensitive: call.args["sensitive"] == .bool(true),
                label: call.args["label"]?.stringValue
            )
            return .success(.object(["op": .string("copy"), "bytes": .number(Double(text.utf8.count))]))
        case "clipboard.paste":
            do { return try .success(Self.pasteValue(await clipboard.paste())) }
            catch PrototypeClipboardError.permissionDenied { return .failure(
                .permissionDenied,
                "Clipboard permission denied"
            ) } catch { return .failure(.platformError, "Clipboard read failed") }
        case "clipboard.hasText": return .success(.bool(clipboard.hasText))
        default: return .failure(.unsupported, "Unknown clipboard call")
        }
    }

    nonisolated static func pasteValue(_ text: String) -> JSONValue {
        var bytes = 0
        var scalars = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            let cost = scalar.utf8.count
            if bytes + cost > maxPrototypeClipboardTextBytes { break }
            scalars.append(scalar)
            bytes += cost
        }
        return .object(["text": .string(String(scalars)), "truncated": .bool(bytes < text.utf8.count)])
    }
}
