package dev.jasonpearson.automobile.desktop.core.datasource

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart

fun <T> Flow<T>.asResult(): Flow<Result<T>> =
    map<T, Result<T>> { Result.Success(data = it) }
        .onStart { emit(Result.Loading) }
        .catch { emit(Result.Error(exception = it, message = it.message)) }
