package dev.jasonpearson.automobile.shared.datasource

import dev.jasonpearson.automobile.shared.test.TestRun

interface TestDataSource {
    suspend fun getTestRuns(): Result<List<TestRun>>
}
