-- ============================================================
-- Ecran Temps — ajout du code PIN (à exécuter APRES schema.sql)
-- A executer dans Supabase > SQL Editor > New query
-- ============================================================

create table if not exists public.app_settings (
  id integer primary key default 1,
  pin_hash text,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

drop policy if exists "app_settings_select" on public.app_settings;
drop policy if exists "app_settings_upsert" on public.app_settings;
drop policy if exists "app_settings_update" on public.app_settings;
create policy "app_settings_select" on public.app_settings for select using (true);
create policy "app_settings_upsert" on public.app_settings for insert with check (true);
create policy "app_settings_update" on public.app_settings for update using (true);

alter publication supabase_realtime add table public.app_settings;
