from __future__ import annotations


class LanguageProcessingError(RuntimeError):
    """A Phase 6 failure whose message is safe to expose through the task API."""

    def __init__(self, message: str, *, cache_hit: bool | None = None) -> None:
        super().__init__(message)
        self.cache_hit = cache_hit


class ProviderAuthenticationError(LanguageProcessingError):
    pass


class ProviderTimeoutError(LanguageProcessingError):
    pass


class ProviderRateLimitError(LanguageProcessingError):
    pass


class NoSpeechError(LanguageProcessingError):
    pass


class ProviderResponseError(LanguageProcessingError):
    pass


class ProviderUnavailableError(LanguageProcessingError):
    pass


class ProviderContentLimitError(LanguageProcessingError):
    pass


class CacheWriteError(LanguageProcessingError):
    pass


def stable_public_error(error: LanguageProcessingError) -> str:
    messages: tuple[tuple[type[LanguageProcessingError], str], ...] = (
        (ProviderAuthenticationError, "Language provider authentication failed"),
        (ProviderTimeoutError, "Language provider timed out"),
        (ProviderRateLimitError, "Language provider rate limit was reached"),
        (NoSpeechError, "No recognizable speech was found"),
        (ProviderResponseError, "Language provider returned an invalid response"),
        (ProviderUnavailableError, "Language provider is unavailable"),
        (ProviderContentLimitError, "Language processing input or output exceeds its limit"),
        (CacheWriteError, "Language processing cache could not be written"),
    )
    for error_type, message in messages:
        if isinstance(error, error_type):
            return message
    return "Language processing failed"
