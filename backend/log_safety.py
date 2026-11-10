# What it does: redacts secrets from every log record (defence in depth)
#
# The code never logs tokens or request headers on purpose; this filter makes sure a token
# that slips into an exception message (an SDK error, a URL with credentials…) is not
# written to the logs either.

import logging
import os
import re

SECRET_ENV_VARS = (
    "GITHUB_TOKEN", "GROQ_API_KEY", "MISTRAL_API_KEY", "ADMIN_KEY",
    "DATABASE_URL", "DATABASE_URL_DIRECT", "TEST_DATABASE_URL",
)
TOKEN_PATTERNS = re.compile(
    r"(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gsk_[A-Za-z0-9]{20,}"
    r"|(?i:x-admin-key|authorization)\s*[:=]\s*(?:(?i:bearer|token|basic)\s+)?\S+"
    r"|(?i:bearer)\s+[A-Za-z0-9._~+/=-]{8,}"
    # Postgres connection strings (URL form, and key=value DSNs with a password)
    r"|(?i:postgres(?:ql)?(?:\+\w+)?)://[^\s'\"<>]+"
    r"|(?i:password)\s*=\s*[^\s'\"]+)"
)
REDACTED = "[redacted]"


def redact(text: str) -> str:
    for name in SECRET_ENV_VARS:
        value = os.environ.get(name)
        if value and len(value) >= 8:
            text = text.replace(value, REDACTED)
    return TOKEN_PATTERNS.sub(REDACTED, text)


class RedactSecrets(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            return True
        cleaned = redact(message)
        if cleaned != message:
            record.msg, record.args = cleaned, ()
        if record.exc_info and record.exc_info[1] is not None:
            exc = record.exc_info[1]
            if redact(str(exc)) != str(exc):
                record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
        return True


_installed = False


def install() -> None:
    """Attach the filter to every handler of the root and uvicorn loggers (idempotent)."""
    global _installed
    if _installed:
        return
    secret_filter = RedactSecrets()
    for name in ("", "uvicorn", "uvicorn.error", "uvicorn.access", "codegraph"):
        logger = logging.getLogger(name)
        logger.addFilter(secret_filter)
        for handler in logger.handlers:
            handler.addFilter(secret_filter)
    _installed = True
