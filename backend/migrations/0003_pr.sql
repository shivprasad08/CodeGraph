-- 0003: pull request impact analyses

create table pr_analyses (
    id               uuid primary key default gen_random_uuid(),
    repo             text not null,
    pr_number        int not null,
    title            text,
    author           text,
    html_url         text,
    base_sha         text,
    head_sha         text,
    head_repo        text,
    base_analysis_id uuid references analyses (id) on delete set null,
    head_analysis_id uuid references analyses (id) on delete set null,
    schema_version   int not null,
    status           text not null check (status in ('queued', 'running', 'done', 'failed')),
    error_code       text,
    error            text,
    result_gz        bytea,
    risk_score       int,
    risk_level       text,
    partial          boolean not null default false,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    finished_at      timestamptz
);

-- One finished result per PR at a given base/head pair and graph schema
create unique index pr_analyses_done_key
    on pr_analyses (lower(repo), pr_number, base_sha, head_sha, schema_version)
    where status = 'done';

-- A PR job points at its pr_analyses row (analysis_id stays null)
alter table jobs add column pr_analysis_id uuid references pr_analyses (id) on delete cascade;

-- History rows own either a repo analysis or a PR analysis
alter table user_analyses
    add column kind text not null default 'repo' check (kind in ('repo', 'pr')),
    add column pr_analysis_id uuid references pr_analyses (id) on delete cascade,
    alter column analysis_id drop not null;
alter table user_analyses
    add constraint user_analyses_one_target check ((analysis_id is null) <> (pr_analysis_id is null));
create index user_analyses_pr on user_analyses (pr_analysis_id);
