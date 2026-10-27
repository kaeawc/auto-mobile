import Foundation

/// The screen an MCP save or open landed on, as native pixels "WxH". On the iPhone Duo the foreground app
/// moves between the cover and inner panels; the host maps this size onto its display inventory
/// (`protoViewerDisplayFor` in src/features/prototype/protoViewer). Twin of the `screen` field in
/// protoViewerContract.ts.
enum PrototypeMcpScreen {
    /// Nil for a screen that reports no usable size, so the host sees no `screen` rather than "0x0".
    static func format(widthPx: Double, heightPx: Double) -> String? {
        guard widthPx.isFinite, heightPx.isFinite, widthPx >= 1, heightPx >= 1, widthPx < 100_000,
              heightPx < 100_000
        else { return nil }
        return "\(Int(widthPx.rounded()))x\(Int(heightPx.rounded()))"
    }
}
