-- ============================================================
-- Ecran Temps — schema Supabase
-- A executer dans Supabase > SQL Editor > New query
-- ============================================================

-- Table des enfants
create table if not exists public.children (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  emoji text not null default '🧒',
  color text not null default '#4f46e5',
  -- temps alloue par jour de la semaine, en MINUTES
  weekly_limits jsonb not null default '{"mon":60,"tue":60,"wed":60,"thu":60,"fri":60,"sat":90,"sun":90}'::jsonb,
  -- etat du jour en cours
  bonus_seconds integer not null default 0,      -- ajustements ponctuels (+ ou -) pour aujourd'hui
  consumed_seconds integer not null default 0,   -- temps deja consomme aujourd'hui (hors session en cours)
  is_running boolean not null default false,
  started_at timestamptz,                        -- rempli quand is_running = true
  reset_date date not null default current_date, -- derniere date pour laquelle le compteur a ete remis a zero
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- Historique des ajustements ponctuels (pour affichage/traçabilite)
create table if not exists public.adjustments (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  delta_seconds integer not null,
  note text,
  created_at timestamptz not null default now()
);

-- Row Level Security : app familiale sans compte utilisateur,
-- on ouvre l'acces via la cle "anon" (qui est publique par design).
-- Ne mets aucune donnee sensible dans cette base.
alter table public.children enable row level security;
alter table public.adjustments enable row level security;

drop policy if exists "children_select" on public.children;
drop policy if exists "children_insert" on public.children;
drop policy if exists "children_update" on public.children;
drop policy if exists "children_delete" on public.children;
create policy "children_select" on public.children for select using (true);
create policy "children_insert" on public.children for insert with check (true);
create policy "children_update" on public.children for update using (true);
create policy "children_delete" on public.children for delete using (true);

drop policy if exists "adjustments_select" on public.adjustments;
drop policy if exists "adjustments_insert" on public.adjustments;
create policy "adjustments_select" on public.adjustments for select using (true);
create policy "adjustments_insert" on public.adjustments for insert with check (true);

-- Realtime : pour synchroniser instantanement entre appareils
alter publication supabase_realtime add table public.children;
alter publication supabase_realtime add table public.adjustments;
