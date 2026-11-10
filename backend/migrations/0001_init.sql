-- 0001: analyses (graphs, gzip-compressed) and the durable job queue

create table analyses (
    id             uuid primary key default gen_random_uuid(),
    repo           text not null,
    commit_sha     text,
    schema_version int not null,
    status         text not null check (status in ('queued', 'running', 'done', 'failed')),
    error_code     text,
    error          text,
    graph_gz       bytea,
    stats          jsonb,
    languages      jsonb,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    finished_at    timestamptz
);

-- One finished graph per repo@commit and graph schema (GitHub names are case-insensitive)
create unique index analyses_done_key
    on analyses (lower(repo), commit_sha, schema_version)
    where status = 'done';

create table jobs (
    id             uuid primary key default gen_random_uuid(),
    analysis_id    uuid references analyses (id) on delete cascade,
    repo_url       text not null,
    status         text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
    stage          text,
    progress       int not null default 0,
    message        text,
    stats          jsonb,
    attempts       int not null default 0,
    locked_by      text,
    locked_until   timestamptz,
    client_ip_hash text,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

create index jobs_status_created on jobs (status, created_at);
