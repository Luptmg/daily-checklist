create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.push_reminder_log (
  workday_id uuid not null references public.workdays(id) on delete cascade,
  reminder_hour smallint not null check (reminder_hour in (12, 16)),
  sent_at timestamptz not null default now(),
  subscription_count integer not null default 0 check (subscription_count >= 0),
  primary key (workday_id, reminder_hour)
);

alter table public.push_reminder_log enable row level security;
revoke all on public.push_reminder_log from anon, authenticated;
