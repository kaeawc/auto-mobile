import AutoMobilePrototype
import Foundation
import SwiftUI

/// Compile the simplest embed with the defaults for assets, storage, network, and all callbacks.
@MainActor
public struct EmbedConsumer: View {
    public init() {}

    public var body: some View {
        AutoMobilePrototypeView(spec: Data("""
        {"id":"embed-fixture","window":{"placement":{"type":"fullscreen"}},
         "root":{"type":"text","text":"Embedded prototype"}}
        """.utf8))
    }
}
