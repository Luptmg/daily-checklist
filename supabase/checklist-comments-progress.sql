-- Stores a per-item explanation when a checklist item is marked as not completed.
-- Safe to run more than once.
alter table public.section_progress
  add column if not exists comments jsonb not null default '{}'::jsonb;
