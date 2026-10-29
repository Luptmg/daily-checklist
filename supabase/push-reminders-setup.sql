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

-- Before scheduling:
-- 1. Deploy supabase/functions/push-reminders/index.ts (already deployed to this project).
-- 2. In Supabase Dashboard > Edge Functions > Secrets, set:
--    PUSH_CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
--    SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase runtime.
-- 3. Generate a strong random secret and use the exact same value for PUSH_CRON_SECRET
--    and the Vault secret below. Never commit the secret to GitHub.
--    Run this with your own secret replacing the placeholder:
-- select vault.create_secret('REPLACE_WITH_RANDOM_SECRET', 'push_cron_secret');

-- Schedule one-minute checks. The function only sends at 12:00 and 16:00
-- in each store's timezone, and only for employees with a workday record.
-- Run this only after creating the Vault secret above.
select cron.schedule(
  'daily-checklist-push-reminders',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://kaudclcgjcruwhydovtf.supabase.co/functions/v1/push-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $job$
);

-- To disable the schedule later:
-- select cron.unschedule('daily-checklist-push-reminders');
