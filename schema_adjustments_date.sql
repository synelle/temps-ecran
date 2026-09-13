-- ============================================================
-- Ecran Temps — date ciblée pour les ajustements ponctuels
-- A executer dans Supabase > SQL Editor > New query
-- ============================================================

alter table public.adjustments add column if not exists date date;
update public.adjustments set date = created_at::date where date is null;
alter table public.adjustments alter column date set default current_date;
alter table public.adjustments alter column date set not null;

create index if not exists adjustments_child_date_idx on public.adjustments (child_id, date);
