import Tachikoma

/// Resolves a Tachikoma model by name (Anthropic/OpenAI/Google — keys read from the environment by
/// Tachikoma itself) and forwards the request to it. Immutable value type → `Sendable`.
public struct TachikomaModelResponder: ModelResponding {
    private let modelName: String

    public init(modelName: String) {
        self.modelName = modelName
    }

    public func respond(_ request: ModelRequest) async throws -> ModelResponse {
        let model = try await ModelProvider.shared.getModel(modelName: modelName)
        return try await model.getResponse(request: request)
    }
}
