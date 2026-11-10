# What it does: users, sessions, analysis ownership, share links and rate limits (Postgres)
#
# Tokens (session cookie, share links) are 32 random bytes; only their SHA-256 is stored.
# Ownership lives in user_analyses: exactly one of user_id (signed in) / owner_session_id
# (anonymous browser session) is set. A soft-deleted row (deleted_at) grants nothing, and
# share links of a deleted row stop working.

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

logger = logging.getLogger("codegraph.auth")

USER_SESSION_DAYS = 30
ANON_SESSION_DAYS = 7
LAST_SEEN_EVERY = timedelta(minutes=10)  # last_seen_at is refreshed at most this often
SHARE_EXPIRY_DAYS = (7, 30, None)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode("utf-8")).digest()


def _owner(session: dict) -> tuple[str, object]:
    """(column, value) that identifies the owner of a session's analyses."""
    return ("user_id", session["user_id"]) if session.get("user_id") else ("owner_session_id", session["id"])


class AuthStore:
    def __init__(self, pool):
        self.pool = pool

    async def _one(self, sql: str, params=None) -> dict | None:
        async with self.pool.connection() as conn:
            cur = await conn.execute(sql, params)
            return await cur.fetchone() if cur.description else None

    async def _all(self, sql: str, params=None) -> list[dict]:
        async with self.pool.connection() as conn:
            cur = await conn.execute(sql, params)
            return await cur.fetchall()

    # -- users and sessions -----------------------------------------------------
    async def upsert_user(self, github_id: int, login: str, name: str | None, avatar_url: str | None) -> dict:
        return await self._one(
            "insert into users (github_id, login, name, avatar_url) values (%s, %s, %s, %s)"
            " on conflict (github_id) do update set login = excluded.login, name = excluded.name,"
            " avatar_url = excluded.avatar_url, last_login_at = now()"
            " returning id, github_id, login, name, avatar_url",
            (github_id, login, name, avatar_url),
        )

    async def create_session(self, user_id=None, user_agent: str | None = None) -> tuple[str, dict]:
        """(cookie token, session row). No user → anonymous session (7 days), else 30 days."""
        token = new_token()
        days = ANON_SESSION_DAYS if user_id is None else USER_SESSION_DAYS
        row = await self._one(
            "insert into sessions (token_hash, user_id, anon, expires_at, user_agent)"
            " values (%s, %s, %s, now() + make_interval(days => %s), %s)"
            " returning id, user_id, anon, expires_at",
            (token_hash(token), user_id, user_id is None, days, (user_agent or "")[:300]),
        )
        return token, row

    async def get_session(self, token: str | None) -> dict | None:
        if not token or len(token) > 200:
            return None
        row = await self._one(
            "select s.id, s.user_id, s.anon, s.expires_at, s.last_seen_at, u.login, u.name, u.avatar_url"
            " from sessions s left join users u on u.id = s.user_id"
            " where s.token_hash = %s and s.expires_at > now()",
            (token_hash(token),),
        )
        if row and datetime.now(timezone.utc) - row["last_seen_at"] > LAST_SEEN_EVERY:
            await self._one("update sessions set last_seen_at = now() where id = %s", (row["id"],))
        return row

    async def delete_session(self, session_id) -> None:
        await self._one("delete from sessions where id = %s", (session_id,))

    async def adopt_anonymous(self, anon_session_id, user_id) -> int:
        """Signing in: the anonymous session's analyses become the user's; the session is deleted."""
        async with self.pool.connection() as conn:
            async with conn.transaction():
                cur = await conn.execute(
                    "update user_analyses set user_id = %s, owner_session_id = null"
                    " where owner_session_id = %s",
                    (user_id, anon_session_id),
                )
                moved = cur.rowcount
                await conn.execute("delete from sessions where id = %s and anon", (anon_session_id,))
        return moved

    # -- ownership --------------------------------------------------------------
    async def add_user_analysis(self, session: dict, analysis_id, job_id) -> str:
        """Owner's row for this analysis: the existing one (moved to the top) or a new one."""
        column, owner = _owner(session)
        row = await self._one(
            f"update user_analyses set job_id = %s, created_at = now() where id = ("
            f" select id from user_analyses where {column} = %s and analysis_id = %s and deleted_at is null"
            f" order by created_at desc limit 1) returning id",
            (job_id, owner, analysis_id),
        )
        if row is None:
            row = await self._one(
                f"insert into user_analyses ({column}, analysis_id, job_id) values (%s, %s, %s) returning id",
                (owner, analysis_id, job_id),
            )
        return str(row["id"])

    async def owns_analysis(self, session: dict | None, analysis_id) -> bool:
        if not session or analysis_id is None:
            return False
        column, owner = _owner(session)
        row = await self._one(
            f"select 1 from user_analyses where {column} = %s and analysis_id = %s and deleted_at is null limit 1",
            (owner, analysis_id),
        )
        return row is not None

    async def owned_commit_analysis(self, session: dict | None, repo: str, sha: str) -> dict | None:
        """The caller's finished analysis of repo@sha (newest graph schema first)."""
        if not session:
            return None
        column, owner = _owner(session)
        return await self._one(
            f"select a.id, a.repo, a.commit_sha, a.schema_version from user_analyses ua"
            f" join analyses a on a.id = ua.analysis_id"
            f" where ua.{column} = %s and ua.deleted_at is null and a.status = 'done'"
            f" and lower(a.repo) = lower(%s) and a.commit_sha = %s"
            f" order by a.schema_version desc limit 1",
            (owner, repo, sha),
        )

    async def list_user_analyses(self, session: dict, limit: int = 200) -> list[dict]:
        """One entry per analysis (the newest row), newest first, with active share counts."""
        column, owner = _owner(session)
        return await self._all(
            f"select * from ("
            f" select distinct on (ua.analysis_id) ua.id, ua.job_id, ua.analysis_id, ua.created_at,"
            f"  a.repo, a.commit_sha, a.status, a.languages, a.health_score, a.health_grade, a.error_code,"
            f"  (select count(*) from share_links sl join user_analyses u2 on u2.id = sl.user_analysis_id"
            f"   where u2.analysis_id = ua.analysis_id and u2.{column} = %(o)s and u2.deleted_at is null"
            f"   and sl.revoked_at is null and (sl.expires_at is null or sl.expires_at > now())) as shares"
            f" from user_analyses ua join analyses a on a.id = ua.analysis_id"
            f" where ua.{column} = %(o)s and ua.deleted_at is null"
            f" order by ua.analysis_id, ua.created_at desc"
            f") t order by created_at desc limit %(limit)s",
            {"o": owner, "limit": limit},
        )

    async def remove_user_analysis(self, session: dict, user_analysis_id) -> bool:
        """Removes the analysis from the owner's list (every row for it); its share links stop working."""
        column, owner = _owner(session)
        row = await self._one(
            f"select analysis_id from user_analyses where id = %s and {column} = %s and deleted_at is null",
            (user_analysis_id, owner),
        )
        if row is None:
            return False
        await self._one(
            f"update user_analyses set deleted_at = now() where {column} = %s and analysis_id = %s and deleted_at is null",
            (owner, row["analysis_id"]),
        )
        return True

    async def user_analysis_for_owner(self, user_id, user_analysis_id) -> dict | None:
        return await self._one(
            "select ua.id, ua.analysis_id from user_analyses ua join analyses a on a.id = ua.analysis_id"
            " where ua.id = %s and ua.user_id = %s and ua.deleted_at is null and a.status = 'done'",
            (user_analysis_id, user_id),
        )

    # -- share links --------------------------------------------------------------
    async def create_share(self, user_analysis_id, user_id, expires_in_days: int | None) -> tuple[str, dict]:
        token = new_token()
        row = await self._one(
            "insert into share_links (token_hash, user_analysis_id, created_by, expires_at)"
            " values (%s, %s, %s, case when %s::int is null then null else now() + make_interval(days => %s::int) end)"
            " returning id, user_analysis_id, created_at, expires_at",
            (token_hash(token), user_analysis_id, user_id, expires_in_days, expires_in_days),
        )
        return token, row

    async def get_share(self, token: str | None) -> dict | None:
        """A usable share (not revoked or expired, its analysis still listed), or None."""
        if not token or len(token) > 200:
            return None
        return await self._one(
            "select sl.id, sl.expires_at, ua.analysis_id, a.repo, a.commit_sha, a.schema_version,"
            " u.login as shared_by_login, u.avatar_url as shared_by_avatar"
            " from share_links sl join user_analyses ua on ua.id = sl.user_analysis_id"
            " join analyses a on a.id = ua.analysis_id join users u on u.id = sl.created_by"
            " where sl.token_hash = %s and sl.revoked_at is null and ua.deleted_at is null and a.status = 'done'"
            " and (sl.expires_at is null or sl.expires_at > now())",
            (token_hash(token),),
        )

    async def record_share_view(self, share_id) -> None:
        await self._one(
            "update share_links set view_count = view_count + 1, last_viewed_at = now() where id = %s", (share_id,)
        )

    async def revoke_share(self, share_id, user_id) -> bool:
        row = await self._one(
            "update share_links set revoked_at = now() where id = %s and created_by = %s and revoked_at is null"
            " returning id",
            (share_id, user_id),
        )
        return row is not None

    async def list_shares(self, user_id, user_analysis_id=None) -> list[dict]:
        """The user's links (newest first); for one analysis when user_analysis_id is given."""
        return await self._all(
            "select sl.id, sl.user_analysis_id, sl.created_at, sl.expires_at, sl.revoked_at, sl.view_count,"
            " sl.last_viewed_at, a.repo, a.commit_sha,"
            " (sl.revoked_at is null and (sl.expires_at is null or sl.expires_at > now())) as active"
            " from share_links sl join user_analyses ua on ua.id = sl.user_analysis_id"
            " join analyses a on a.id = ua.analysis_id"
            " where sl.created_by = %(u)s and ua.deleted_at is null"
            " and (%(ua)s::uuid is null or ua.analysis_id = (select analysis_id from user_analyses where id = %(ua)s::uuid))"
            " order by sl.created_at desc limit 200",
            {"u": user_id, "ua": user_analysis_id},
        )

    # -- rate limits ----------------------------------------------------------------
    async def rate_hit(self, keys: list[str], limit: int, window: timedelta) -> int | None:
        """
        Counts one event under every key unless one of them already has `limit` events in the
        window; then nothing is counted and the seconds until a slot frees up are returned.
        """
        async with self.pool.connection() as conn:
            async with conn.transaction():
                for key in sorted(keys):  # serialise concurrent hits on the same key
                    await conn.execute("select pg_advisory_xact_lock(hashtext(%s))", (key,))
                for key in keys:
                    cur = await conn.execute(
                        "select count(*) as n, min(at) as oldest from rate_events"
                        " where key = %s and at > now() - make_interval(secs => %s)",
                        (key, window.total_seconds()),
                    )
                    row = await cur.fetchone()
                    if row["n"] >= limit:
                        wait = row["oldest"] + window - datetime.now(timezone.utc)
                        return max(1, int(wait.total_seconds()))
                for key in keys:
                    await conn.execute("insert into rate_events (key) values (%s)", (key,))
        return None
