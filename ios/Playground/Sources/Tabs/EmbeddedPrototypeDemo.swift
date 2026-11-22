import SwiftUI

/// Hosts the generated embedding sample, drawn in-app by the AutoMobilePrototype renderer.
struct EmbeddedPrototypeDemo: View {
    var body: some View {
        EmbeddingSamplePrototype()
            .navigationTitle("Embedded Prototype")
            .navigationBarTitleDisplayMode(.inline)
    }
}
