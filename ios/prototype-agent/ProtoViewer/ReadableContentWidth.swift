import SwiftUI

/// Caps text-heavy ProtoViewer chrome (settings, licenses, error text) at a readable measure at regular
/// width and centres it; compact keeps the full width.
private struct ReadableContentWidth: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    func body(content: Content) -> some View {
        let width = ProtoViewerWidthClass(isRegular: horizontalSizeClass == .regular).readableContentWidth
        content
            .frame(maxWidth: width.map { CGFloat($0) } ?? .infinity)
            .frame(maxWidth: .infinity)
    }
}

extension View {
    func readableContentWidth() -> some View {
        modifier(ReadableContentWidth())
    }
}
