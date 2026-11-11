-- 0004: PR result versions. A stored PR result is reused only when its result_version is the
-- current one; older rows (null = before versions were recorded) are recomputed. replaces_id
-- links a recompute to the stale result it replaces (its jobs, history rows and share links
-- move to the new result when it finishes).

alter table pr_analyses
    add column result_version int,
    add column replaces_id uuid references pr_analyses (id) on delete set null;

drop index pr_analyses_done_key;
create unique index pr_analyses_done_key
    on pr_analyses (lower(repo), pr_number, base_sha, head_sha, schema_version, coalesce(result_version, 0))
    where status = 'done';

create index pr_analyses_replaces on pr_analyses (replaces_id) where replaces_id is not null;
