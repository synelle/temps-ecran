-- ============================================================
-- Ecran Temps — type d'ajustement (temps offert/retiré VS temps
-- oublié/déjà utilisé enregistré après coup)
-- A executer dans Supabase > SQL Editor > New query
-- ============================================================

alter table public.adjustments add column if not exists kind text not null default 'budget';
alter table public.adjustments drop constraint if exists adjustments_kind_check;
alter table public.adjustments add constraint adjustments_kind_check check (kind in ('budget', 'used'));
