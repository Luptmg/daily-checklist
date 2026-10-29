import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const cronSecret = Deno.env.get("PUSH_CRON_SECRET");
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
    return json({ error: "Missing server configuration" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const now = new Date();
    const { data: stores, error: storesError } = await supabase
      .from("stores").select("id,name,timezone");
    if (storesError) throw storesError;

    const dueStores = (stores || []).filter((store) => {
      if (!store.timezone) return false;
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: store.timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(now);
      const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
      return p.minute === "00" && (p.hour === "12" || p.hour === "16");
    });

    if (!dueStores.length) return json({ sent: 0, skipped: "not a reminder time for any store" });

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const store of dueStores) {
      const localDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: store.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
      const localHour = new Intl.DateTimeFormat("en-GB", {
        timeZone: store.timezone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(now);
      const reminderHour = Number(localHour);

      const { data: workdays, error: workdaysError } = await supabase
        .from("workdays")
        .select("id,employee_id,store_id,employees!inner(id,active)")
        .eq("store_id", store.id)
        .eq("work_date", localDate)
        .eq("employees.active", true);
      if (workdaysError) throw workdaysError;

      for (const workday of workdays || []) {
        const { data: profile, error: profileError } = await supabase
          .from("profiles").select("user_id")
          .eq("employee_id", workday.employee_id)
          .eq("role", "employee").maybeSingle();
        if (profileError) throw profileError;
        if (!profile?.user_id) { skipped++; continue; }

        const { data: alreadySent, error: logCheckError } = await supabase
          .from("push_reminder_log").select("workday_id")
          .eq("workday_id", workday.id).eq("reminder_hour", reminderHour).maybeSingle();
        if (logCheckError) throw logCheckError;
        if (alreadySent) { skipped++; continue; }

        const { data: subscriptions, error: subsError } = await supabase
          .from("push_subscriptions")
          .select("id,endpoint,p256dh,auth")
          .eq("user_id", profile.user_id);
        if (subsError) throw subsError;
        if (!subscriptions?.length) { skipped++; continue; }

        const payload = JSON.stringify({
          title: "Пора проверить порядок",
          body: reminderHour === 12
            ? "Проверь порядок в торговом зале и на рабочем месте."
            : "Время повторно проверить чистоту и порядок в зале.",
          url: "/",
          tag: `checklist-${localDate}-${reminderHour}`,
        });

        let workdaySent = 0;
        for (const sub of subscriptions) {
          try {
            await webpush.sendNotification({
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            }, payload);
            sent++;
            workdaySent++;
          } catch (err) {
            const statusCode = (err as { statusCode?: number }).statusCode;
            if (statusCode === 404 || statusCode === 410) {
              await supabase.from("push_subscriptions").delete().eq("id", sub.id);
            }
            failed++;
          }
        }

        if (workdaySent > 0) {
          const { error: logInsertError } = await supabase.from("push_reminder_log").insert({
            workday_id: workday.id,
            reminder_hour: reminderHour,
            sent_at: new Date().toISOString(),
            subscription_count: workdaySent,
          });
          if (logInsertError && logInsertError.code !== "23505") throw logInsertError;
        }
      }
    }

    return json({ sent, failed, skipped, stores_checked: dueStores.length });
  } catch (err) {
    console.error("push-reminders failed", err);
    return json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});