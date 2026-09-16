import SwiftUI

/// Repeated identifiers intentionally exercise descendant selection (#7156).
struct NestedSelectorsView: View {
    var body: some View {
        VStack(spacing: 20) {
            Text("Nested selectors")
            cart("cart_A", items: ["item_42", "item_73"])
            cart("cart_B", items: ["item_42"])
        }
        .padding()
    }

    private func cart(_ identifier: String, items: [String]) -> some View {
        VStack {
            Text(identifier)
            VStack {
                ForEach(items, id: \.self) { item in
                    NestedSelectorRow(cart: identifier, item: item)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

private struct NestedSelectorRow: View {
    let cart: String
    let item: String
    @State private var quantity = "1"
    @State private var removed = false

    var body: some View {
        VStack {
            Text("\(cart)/\(item): quantity=\(quantity), removed=\(removed)")
                .accessibilityIdentifier("state")
            HStack {
                TextField("Quantity", text: $quantity)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("quantity")
                if !removed {
                    Button("Remove") { removed = true }
                        .accessibilityIdentifier("remove")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(item)
    }
}
