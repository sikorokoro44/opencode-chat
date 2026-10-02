package com.sikorokoro44.opencodechat.data.remote

/** Outcome of a backend call without throwing across the UI boundary. */
sealed interface ApiResult<out T> {
    data class Success<T>(val value: T) : ApiResult<T>

    data class Failure(
        val code: String,
        val message: String,
        val retryable: Boolean = false,
        val status: Int? = null,
    ) : ApiResult<Nothing>
}

inline fun <T, R> ApiResult<T>.map(transform: (T) -> R): ApiResult<R> = when (this) {
    is ApiResult.Success -> ApiResult.Success(transform(value))
    is ApiResult.Failure -> this
}

fun <T> ApiResult<T>.valueOrNull(): T? = (this as? ApiResult.Success)?.value

fun <T> ApiResult<T>.failureOrNull(): ApiResult.Failure? = this as? ApiResult.Failure
