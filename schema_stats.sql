-- ============================================================
-- Ecran Temps — historique quotidien pour le calendrier de stats
-- A executer dans Supabase > SQL Editor > New query
-- ============================================================

create table if not exists public.daily_stats (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  date date not null,
  consumed_seconds integer not null default 0,
  budget_seconds integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (child_id, date)
);

create index if not exists daily_stats_child_date_idx on public.daily_stats (child_id, date);

alter table public.daily_stats enable row level security;

drop policy if exists "daily_stats_select" on public.daily_stats;
drop policy if exists "daily_stats_insert" on public.daily_stats;
drop policy if exists "daily_stats_update" on public.daily_stats;
create policy "daily_stats_select" on public.daily_stats for select using (true);
create policy "daily_stats_insert" on public.daily_stats for insert with check (true);
create policy "daily_stats_update" on public.daily_stats for update using (true);

alter publication supabase_realtime add table public.daily_stats;
