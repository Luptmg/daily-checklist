// Push subscription helper for the daily checklist.
const CHECKLIST_VAPID_PUBLIC_KEY = "BFRDFBsMXn2TzGsW92aD_OykXI0yJD64SesJUezbDGto4M66KGSyl0OV2u4P8l071QliDEvJ_7BBQVYgJywEViw";

function pushBase64ToBytes(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

async function updatePushButton() {
  const button = document.getElementById("pushButton");
  if (!button) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    button.disabled = true;
    button.textContent = "Push не поддерживается этим браузером";
    return;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration("./");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    button.disabled = false;
    button.textContent = sub ? "Отключить уведомления" : "Включить уведомления";
  } catch (_) {
    button.disabled = false;
    button.textContent = "Включить уведомления";
  }
}

async function togglePushNotifications() {
  const button = document.getElementById("pushButton");
  if (typeof user === "undefined" || !user || typeof profile === "undefined" || profile?.role !== "employee") {
    msg("Push-уведомления доступны сотрудникам после входа.", "notice error");
    return;
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    msg("Этот браузер не поддерживает push. Открой сайт по HTTPS в современном браузере.", "notice error");
    return;
  }
  if (button) button.disabled = true;
  try {
    const registration = await navigator.serviceWorker.register("./sw.js");
    const ready = await navigator.serviceWorker.ready;
    let subscription = await ready.pushManager.getSubscription();
    if (subscription) {
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe();
      const { error } = await sb.from("push_subscriptions").delete()
        .eq("user_id", user.id).eq("endpoint", endpoint);
      if (error) throw error;
      msg("Уведомления отключены на этом устройстве.", "notice success");
    } else {
      let permission = Notification.permission;
      if (permission === "default") permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Разрешение на уведомления не выдано в настройках браузера.");
      subscription = await ready.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: pushBase64ToBytes(CHECKLIST_VAPID_PUBLIC_KEY)
      });
      const keys = subscription.toJSON().keys || {};
      if (!keys.p256dh || !keys.auth) throw new Error("Не удалось получить ключи push-подписки.");
      const { error } = await sb.from("push_subscriptions").upsert({
        user_id: user.id,
        endpoint: subscription.endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        user_agent: navigator.userAgent,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,endpoint" });
      if (error) {
        await subscription.unsubscribe();
        throw error;
      }
      msg("Уведомления включены на этом устройстве.", "notice success");
    }
  } catch (error) {
    msg("Не удалось настроить уведомления: " + (error.message || String(error)), "notice error");
  } finally {
    if (button) button.disabled = false;
    await updatePushButton();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  updatePushButton();
});
