import SwiftUI

/// Results stay in the prototype window and in an eager stack so every row can be observed.
@MainActor
struct PrototypeSearchBarView: View {
    @Environment(\.prototypePalette) private var palette
    let node: PrototypeNode
    let model: PrototypeModel
    let style: Style?

    var body: some View {
        let active = node.searchBarActive(state: model.state)
        let docked = node.variant == "docked"
        let colors = ComponentColors(palette: palette)
        VStack(alignment: .leading, spacing: 0) {
            PrototypeTextFieldView(node: node, model: model)
            if active, let child = node.child {
                VStack(alignment: .leading, spacing: 0) {
                    NodeView(node: child, model: model)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if active, !docked { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, maxHeight: active && !docked ? .infinity : nil, alignment: .topLeading)
        .background(style?.hasAuthoredFill ?? false ? .clear : colors.surfaceHigh)
        .clipShape(RoundedRectangle(cornerRadius: docked || !active ? 24 : 0))
        .shadow(color: .black.opacity(active && docked ? 0.2 : 0), radius: 8, y: 4)
    }
}
