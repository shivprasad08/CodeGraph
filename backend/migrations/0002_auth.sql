-- 0002: GitHub sign-in, sessions, per-owner analysis history, share links, DB-backed rate limits

create table users (
    id            uuid primary key default gen_random_uuid(),
    github_id     bigint not null unique,
    login         text not null,
    name          text,
    avatar_url    text,
    created_at    timestamptz not null default now(),
    last_login_at timestamptz not null default now()
);

-- Only the SHA-256 of the cookie token is stored. Anonymous sessions have no user.
create table sessions (
    id           uuid primary key default gen_random_uuid(),
    token_hash   bytea not null unique,
    user_id      uuid references users (id) on delete cascade,
    anon         boolean not null,
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null,
    last_seen_at timestamptz not null default now(),
    user_agent   text,
    check (anon = (user_id is null))
);
create index sessions_expires on sessions (expires_at);

-- Ownership: analyses stay deduplicated (repo@sha@schema); each owner gets their own row
create table user_analyses (
    id               uuid primary key default gen_random_uuid(),
    owner_session_id uuid references sessions (id) on delete cascade,
    user_id          uuid references users (id) on delete cascade,
    analysis_id      uuid not null references analyses (id) on delete cascade,
    job_id           uuid references jobs (id) on delete set null,
    created_at       timestamptz not null default now(),
    deleted_at       timestamptz,
    check ((user_id is null) <> (owner_session_id is null))
);
create index user_analyses_user on user_analyses (user_id, created_at desc);
create index user_analyses_session on user_analyses (owner_session_id, created_at desc);
create index user_analyses_analysis on user_analyses (analysis_id);

create table share_links (
    id               uuid primary key default gen_random_uuid(),
    token_hash       bytea not null unique,
    user_analysis_id uuid not null references user_analyses (id) on delete cascade,
    created_by       uuid not null references users (id) on delete cascade,
    created_at       timestamptz not null default now(),
    expires_at       timestamptz,
    revoked_at       timestamptz,
    view_count       int not null default 0,
    last_viewed_at   timestamptz
);
create index share_links_owner on share_links (created_by, created_at desc);

-- Sliding-window rate limits: one row per counted event, pruned daily
create table rate_events (
    key text not null,
    at  timestamptz not null default now()
);
create index rate_events_key_at on rate_events (key, at);

-- Shown in the analysis history without decompressing graphs (null for older rows)
alter table analyses add column health_score int, add column health_grade text;
