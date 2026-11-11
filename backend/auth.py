# What it does: GitHub sign-in (OAuth App + PKCE), session cookies, CSRF checks, access control
#
# The frontend reaches the API through its own origin (Vercel rewrite /api/* → Render, Vite
# proxy locally), so cg_session is a first-party cookie: HttpOnly; Secure; SameSite=Lax.
#
# Sign-in: /auth/github/login sets a signed 10-minute state cookie (state, PKCE verifier,
# next) and redirects to GitHub with scope read:user. /auth/github/callback checks the state,
# exchanges the code (with the verifier), reads /user, upserts the user and DISCARDS the
# GitHub token. A new session replaces any old one; an anonymous session's analyses move to
# the user. `next` must be a same-site relative path (no open redirects).
#
# Access: an analysis is visible to its owner (user or anonymous session) or with a share
# token (X-Share-Token). Everything else gets 403 private_analysis — the same answer whether
# or not anyone analysed that repo.

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from types import SimpleNamespace
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

import config
from auth_store import ANON_SESSION_DAYS, USER_SESSION_DAYS

logger = logging.getLogger("codegraph.auth")

SESSION_COOKIE = "cg_session"
STATE_COOKIE = "cg_oauth"
STATE_TTL_SECONDS = 600
CSRF_HEADER = "x-codegraph"
SHARE_HEADER = "x-share-token"
GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"
DEFAULT_NEXT = "/analyses"
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

PRIVATE = {"error": "This analysis is private.", "error_code": "private_analysis", "detail": None}

# Set by main at startup: runtime.auth is the AuthStore (None without Postgres: no access control);
# runtime.load_graph(analysis_id, repo, sha, schema_version) reads a stored graph;
# runtime.load_pr(pr_analysis_id) reads a stored PR result
runtime = SimpleNamespace(auth=None, load_graph=None, load_pr=None)

router = APIRouter()


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def cookie_secure() -> bool:
    return config.PUBLIC_APP_URL.startswith("https://")


def app_origin() -> str:
    parts = urlsplit(config.PUBLIC_APP_URL)
    return f"{parts.scheme}://{parts.netloc}"


def redirect_uri() -> str:
    return f"{config.PUBLIC_APP_URL}/api/auth/github/callback"


def safe_next(value) -> str:
    """A relative path on this site, else the default. Rejects //host, /\\host, schemes, control chars."""
    if not isinstance(value, str) or not value or len(value) > 512:
        return DEFAULT_NEXT
    if not value.startswith("/") or value.startswith("//") or value.startswith("/\\"):
        return DEFAULT_NEXT
    if any(c in value for c in "\\\r\n\t\x00") or any(ord(c) < 32 for c in value):
        return DEFAULT_NEXT
    parts = urlsplit(value)
    if parts.scheme or parts.netloc:
        return DEFAULT_NEXT
    return value


def sign(payload: dict) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    mac = hmac.new(config.SESSION_SECRET.encode(), body.encode(), hashlib.sha256).digest()
    return f"{body}.{_b64(mac)}"


def unsign(value: str | None) -> dict | None:
    if not value or "." not in value or not config.SESSION_SECRET:
        return None
    body, mac = value.rsplit(".", 1)
    expected = hmac.new(config.SESSION_SECRET.encode(), body.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(_unb64(mac), expected):
            return None
        payload = json.loads(_unb64(body))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("e", 0) < time.time():
        return None
    return payload


def set_session_cookie(response, token: str, anon: bool) -> None:
    days = ANON_SESSION_DAYS if anon else USER_SESSION_DAYS
    response.set_cookie(
        SESSION_COOKIE, token, max_age=days * 86400, path="/",
        httponly=True, secure=cookie_secure(), samesite="lax",
    )


def clear_cookie(response, name: str) -> None:
    response.delete_cookie(name, path="/", httponly=True, secure=cookie_secure(), samesite="lax")


# ---------------------------------------------------------------------------
# Request context: session and share token
# ---------------------------------------------------------------------------
async def current_session(request: Request) -> dict | None:
    if runtime.auth is None:
        return None
    if not hasattr(request.state, "cg_session"):
        request.state.cg_session = await runtime.auth.get_session(request.cookies.get(SESSION_COOKIE))
    return request.state.cg_session


async def current_share(request: Request) -> dict | None:
    if runtime.auth is None:
        return None
    if not hasattr(request.state, "cg_share"):
        request.state.cg_share = await runtime.auth.get_share(request.headers.get(SHARE_HEADER))
    return request.state.cg_share


def access_control_enabled() -> bool:
    return runtime.auth is not None


async def can_view_analysis(request: Request, analysis_id) -> bool:
    """Owner, or a share token for this exact analysis. Always true without Postgres (local dev)."""
    if runtime.auth is None:
        return True
    share = await current_share(request)
    if share and analysis_id is not None and str(share["analysis_id"]) == str(analysis_id):
        return True
    return await runtime.auth.owns_analysis(await current_session(request), analysis_id)


async def can_view_pr(request: Request, pr_analysis_id) -> bool:
    """Owner of the PR analysis, or a share token for it. Always true without Postgres."""
    if runtime.auth is None:
        return True
    share = await current_share(request)
    if share and pr_analysis_id is not None and str(share.get("pr_analysis_id")) == str(pr_analysis_id):
        return True
    return await runtime.auth.owns_pr_analysis(await current_session(request), pr_analysis_id)


async def commit_analysis(request: Request, repo: str, sha: str) -> dict | None:
    """The analysis of repo@sha this caller may read (via share token or ownership), or None."""
    share = await current_share(request)
    if share and share.get("analysis_id") and share["repo"].lower() == repo.lower() and share["commit_sha"] == sha:
        return {"id": share["analysis_id"], "repo": share["repo"], "commit_sha": sha,
                "schema_version": share["schema_version"]}
    return await runtime.auth.owned_commit_analysis(await current_session(request), repo, sha)


def private_response() -> JSONResponse:
    return JSONResponse(status_code=403, content=PRIVATE)


# ---------------------------------------------------------------------------
# CSRF: state-changing requests must come from the app
# ---------------------------------------------------------------------------
def csrf_ok(request: Request) -> bool:
    if request.method not in UNSAFE_METHODS:
        return True
    if request.headers.get(CSRF_HEADER) == "1":
        return True
    origin = request.headers.get("origin")
    if origin:
        return origin.rstrip("/") == app_origin()
    referer = request.headers.get("referer") or ""
    return referer.startswith(app_origin() + "/")


class CSRFMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not csrf_ok(request):
            return JSONResponse(
                status_code=403,
                content={"error": "Request blocked: it did not come from CodeGraph.", "error_code": "csrf", "detail": None},
            )
        return await call_next(request)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
def _signin_configured() -> bool:
    return bool(runtime.auth and config.GITHUB_OAUTH_CLIENT_ID and config.GITHUB_OAUTH_CLIENT_SECRET and config.SESSION_SECRET)


def _back_to_app(path: str, problem: str | None = None) -> RedirectResponse:
    target = path if problem is None else f"/?signin={problem}"
    response = RedirectResponse(target, status_code=302)
    clear_cookie(response, STATE_COOKIE)
    return response


@router.get("/auth/github/login")
async def github_login(next: str | None = None):
    if not _signin_configured():
        return JSONResponse(status_code=503, content={"error": "Sign-in is not available right now.", "detail": None})
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)  # 64 chars (PKCE allows 43–128)
    challenge = _b64(hashlib.sha256(verifier.encode("ascii")).digest())
    query = urlencode({
        "client_id": config.GITHUB_OAUTH_CLIENT_ID,
        "redirect_uri": redirect_uri(),
        "scope": "read:user",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "allow_signup": "true",
    })
    response = RedirectResponse(f"{GITHUB_AUTHORIZE}?{query}", status_code=302)
    response.set_cookie(
        STATE_COOKIE, sign({"s": state, "v": verifier, "n": safe_next(next), "e": int(time.time()) + STATE_TTL_SECONDS}),
        max_age=STATE_TTL_SECONDS, path="/", httponly=True, secure=cookie_secure(), samesite="lax",
    )
    return response


async def _github_user(code: str, verifier: str) -> dict | None:
    """Exchanges the code and reads the profile. The access token never leaves this function."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0)) as client:
        token_resp = await client.post(
            GITHUB_TOKEN_URL,
            headers={"Accept": "application/json"},
            data={
                "client_id": config.GITHUB_OAUTH_CLIENT_ID,
                "client_secret": config.GITHUB_OAUTH_CLIENT_SECRET,
                "code": code,
                "redirect_uri": redirect_uri(),
                "code_verifier": verifier,
            },
        )
        access_token = (token_resp.json() if token_resp.status_code == 200 else {}).get("access_token")
        if not access_token:
            logger.warning(f"[auth] code exchange failed (HTTP {token_resp.status_code})")
            return None
        user_resp = await client.get(
            GITHUB_USER_URL,
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/vnd.github+json"},
        )
        del access_token  # never stored
        if user_resp.status_code != 200:
            logger.warning(f"[auth] GitHub /user failed (HTTP {user_resp.status_code})")
            return None
        return user_resp.json()


@router.get("/auth/github/callback")
async def github_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    if not _signin_configured():
        return _back_to_app("/", "unavailable")
    saved = unsign(request.cookies.get(STATE_COOKIE))
    if error:
        return _back_to_app("/", "cancelled")
    if not saved or not state or not code or not hmac.compare_digest(str(saved.get("s", "")), state):
        logger.warning("[auth] OAuth state missing or mismatched")
        return _back_to_app("/", "failed")
    try:
        profile = await _github_user(code, saved["v"])
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(f"[auth] GitHub request failed: {type(e).__name__}")
        profile = None
    if not profile or not isinstance(profile.get("id"), int) or not profile.get("login"):
        return _back_to_app("/", "failed")

    store = runtime.auth
    user = await store.upsert_user(profile["id"], profile["login"], profile.get("name"), profile.get("avatar_url"))
    previous = await current_session(request)
    if previous:
        if previous.get("anon"):
            moved = await store.adopt_anonymous(previous["id"], user["id"])
            logger.info(f"[auth] {user['login']} signed in; {moved} anonymous analyses moved")
        else:
            await store.delete_session(previous["id"])
    token, _session = await store.create_session(user["id"], request.headers.get("user-agent"))
    response = _back_to_app(safe_next(saved.get("n")))
    set_session_cookie(response, token, anon=False)
    return response


@router.get("/auth/me")
async def me(request: Request):
    session = await current_session(request)
    if not session or session.get("anon"):
        return JSONResponse(status_code=401, content={"error": "Not signed in", "detail": None})
    return {"user": {"login": session["login"], "name": session["name"], "avatar_url": session["avatar_url"]}}


@router.post("/auth/logout")
async def logout(request: Request):
    session = await current_session(request)
    if session:
        await runtime.auth.delete_session(session["id"])
    response = JSONResponse({"ok": True})
    clear_cookie(response, SESSION_COOKIE)
    return response


async def ensure_session(request: Request) -> dict | None:
    """
    The caller's session; creates an anonymous one when there is none. Its cookie is set on
    the response by attach_new_session().
    """
    if runtime.auth is None:
        return None
    session = await current_session(request)
    if session:
        return session
    token, session = await runtime.auth.create_session(None, request.headers.get("user-agent"))
    request.state.cg_session = session
    request.state.cg_new_token = token
    return session


def attach_new_session(request: Request, response):
    token = getattr(request.state, "cg_new_token", None)
    if token:
        set_session_cookie(response, token, anon=True)
    return response


def signed_in(session: dict | None) -> bool:
    return bool(session and not session.get("anon"))


def sign_in_required() -> JSONResponse:
    return JSONResponse(status_code=401, content={"error": "Sign in to share", "error_code": "sign_in_required", "detail": None})
