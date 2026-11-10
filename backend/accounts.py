# What it does: analysis history (/me/analyses) and share links (/shares, /me/shares)
#
# History belongs to the caller's session: a signed-in user, or the anonymous browser session.
# Share links are for signed-in owners only. A link's token is shown once, at creation; only
# its hash is stored. Unknown, revoked and expired links all get the same 404.

import uuid

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from auth import current_session, runtime, sign_in_required, signed_in
from auth_store import SHARE_EXPIRY_DAYS

router = APIRouter()

SHARE_GONE = {"error": "This link is no longer available.", "error_code": "share_unavailable", "detail": None}
NOT_FOUND = {"error": "Not found", "detail": None}


class ShareRequest(BaseModel):
    user_analysis_id: str
    expires_in_days: int | None = 7


def _iso(value):
    return value.isoformat() if value else None


def _uuid(value):
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _no_store() -> dict:
    return {"Cache-Control": "private, no-store"}


def _unavailable() -> JSONResponse:
    return JSONResponse(status_code=503, content={"error": "Accounts are not available on this server.", "detail": None})


@router.get("/me/analyses")
async def my_analyses(request: Request):
    if runtime.auth is None:
        return _unavailable()
    session = await current_session(request)
    if not session:
        return JSONResponse({"signed_in": False, "analyses": []}, headers=_no_store())
    rows = await runtime.auth.list_user_analyses(session)
    return JSONResponse({
        "signed_in": signed_in(session),
        "analyses": [{
            "id": str(r["id"]),
            "job_id": str(r["job_id"]) if r["job_id"] else None,
            "repo": r["repo"],
            "commit_sha": r["commit_sha"],
            "status": {"failed": "error"}.get(r["status"], r["status"]),
            "error_code": r["error_code"],
            "languages": r["languages"] or [],
            "health_score": r["health_score"],
            "health_grade": r["health_grade"],
            "kind": r["kind"],
            "pr_number": r["pr_number"],
            "pr_title": r["pr_title"],
            "risk_score": r["risk_score"],
            "risk_level": r["risk_level"],
            "base_sha": r["base_sha"],
            "created_at": _iso(r["created_at"]),
            "shares": r["shares"],
        } for r in rows],
    }, headers=_no_store())


@router.delete("/me/analyses/{user_analysis_id}")
async def remove_my_analysis(user_analysis_id: str, request: Request):
    if runtime.auth is None:
        return _unavailable()
    session = await current_session(request)
    ua = _uuid(user_analysis_id)
    if not session or ua is None or not await runtime.auth.remove_user_analysis(session, ua):
        return JSONResponse(status_code=404, content=NOT_FOUND)
    return {"removed": True}


@router.post("/shares")
async def create_share(body: ShareRequest, request: Request):
    if runtime.auth is None:
        return _unavailable()
    session = await current_session(request)
    if not signed_in(session):
        return sign_in_required()
    if body.expires_in_days not in SHARE_EXPIRY_DAYS:
        return JSONResponse(status_code=422, content={"error": "expires_in_days must be 7, 30 or null", "detail": None})
    ua = _uuid(body.user_analysis_id)
    owned = ua and await runtime.auth.user_analysis_for_owner(session["user_id"], ua)
    if not owned:
        return JSONResponse(status_code=404, content=NOT_FOUND)
    token, row = await runtime.auth.create_share(ua, session["user_id"], body.expires_in_days)
    return JSONResponse({
        "id": str(row["id"]),
        "url": f"/s/{token}",
        "created_at": _iso(row["created_at"]),
        "expires_at": _iso(row["expires_at"]),
    }, headers=_no_store())


@router.get("/shares/{token}")
async def open_share(token: str):
    if runtime.auth is None:
        return _unavailable()
    share = await runtime.auth.get_share(token)
    if share and share["pr_analysis_id"]:
        result = await runtime.load_pr(share["pr_analysis_id"]) if runtime.load_pr else None
        if not result:
            return JSONResponse(status_code=404, content=SHARE_GONE, headers=_no_store())
        await runtime.auth.record_share_view(share["id"])
        return JSONResponse({
            "kind": "pr",
            "share": {
                "repo": share["repo"],
                "pr_number": share["pr_number"],
                "expires_at": _iso(share["expires_at"]),
                "shared_by": {"login": share["shared_by_login"], "avatar_url": share["shared_by_avatar"]},
            },
            "job_id": str(share["job_id"]) if share["job_id"] else None,
            "result": result,
        }, headers=_no_store())
    graph = await runtime.load_graph(share["analysis_id"], share["repo"], share["commit_sha"], share["schema_version"]) if share else None
    if not share or not graph:
        return JSONResponse(status_code=404, content=SHARE_GONE, headers=_no_store())
    await runtime.auth.record_share_view(share["id"])
    return JSONResponse({
        "kind": "repo",
        "share": {
            "repo": share["repo"],
            "commit_sha": share["commit_sha"],
            "expires_at": _iso(share["expires_at"]),
            "shared_by": {"login": share["shared_by_login"], "avatar_url": share["shared_by_avatar"]},
        },
        "graph": graph,
    }, headers=_no_store())


@router.delete("/shares/{share_id}")
async def revoke_share(share_id: str, request: Request):
    if runtime.auth is None:
        return _unavailable()
    session = await current_session(request)
    sid = _uuid(share_id)
    if not signed_in(session) or sid is None or not await runtime.auth.revoke_share(sid, session["user_id"]):
        return JSONResponse(status_code=404, content=NOT_FOUND)
    return {"revoked": True}


@router.get("/me/shares")
async def my_shares(request: Request, user_analysis_id: str | None = None):
    if runtime.auth is None:
        return _unavailable()
    session = await current_session(request)
    if not signed_in(session):
        return sign_in_required()
    rows = await runtime.auth.list_shares(session["user_id"], _uuid(user_analysis_id) if user_analysis_id else None)
    return JSONResponse({"shares": [{
        "id": str(r["id"]),
        "user_analysis_id": str(r["user_analysis_id"]),
        "repo": r["repo"],
        "commit_sha": r["commit_sha"],
        "created_at": _iso(r["created_at"]),
        "expires_at": _iso(r["expires_at"]),
        "revoked_at": _iso(r["revoked_at"]),
        "view_count": r["view_count"],
        "last_viewed_at": _iso(r["last_viewed_at"]),
        "active": r["active"],
    } for r in rows]}, headers=_no_store())
