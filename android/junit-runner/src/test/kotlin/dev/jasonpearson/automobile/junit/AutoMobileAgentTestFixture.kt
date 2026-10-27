package dev.jasonpearson.automobile.junit

import java.io.File
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.io.TempDir

internal abstract class AutoMobileAgentTestFixture {

  protected lateinit var fakeConfigProvider: FakeAgentConfigProvider
  protected lateinit var fakeFileSystemOperations: FakeAgentFileSystemOperations
  protected lateinit var fakeAiAgentFactory: FakeAgentAIAgentFactory
  protected lateinit var fakeTimeProvider: FakeAgentTimeProvider
  protected lateinit var fakeMcpClient: FakeAgentMCPClient
  protected lateinit var fakeAIAgent: FakeAIAgent
  protected lateinit var autoMobileAgent: AutoMobileAgent

  @TempDir lateinit var tempDir: File

  @BeforeEach
  fun setUp() {
    fakeConfigProvider = FakeAgentConfigProvider()
    fakeFileSystemOperations = FakeAgentFileSystemOperations()
    fakeAIAgent = FakeAIAgent()
    fakeAiAgentFactory = FakeAgentAIAgentFactory(fakeAIAgent)
    fakeTimeProvider = FakeAgentTimeProvider()
    fakeMcpClient = FakeAgentMCPClient()

    autoMobileAgent =
      AutoMobileAgent(
        configProvider = fakeConfigProvider,
        fileSystemOperations = fakeFileSystemOperations,
        aiAgentFactory = fakeAiAgentFactory,
        timeProvider = fakeTimeProvider,
        mcpClient = fakeMcpClient,
        recoveryConfigProvider = StaticRecoveryConfigProvider(maxToolCalls = 5),
      )
  }
}
