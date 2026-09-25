import { api } from '../api/client';

/** Registers the service worker once, for push notifications. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded =
    base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Asks the browser for permission and registers this device. Returns false if refused. */
export async function enablePush(): Promise<boolean> {
  const { publicKey } = await api<{ publicKey: string | null }>('/notifications/push/key');
  if (!publicKey || !pushSupported()) return false;
  if ((await Notification.requestPermission()) !== 'granted') return false;
  const reg =
    (await navigator.serviceWorker.getRegistration()) ??
    (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api('/notifications/push/subscriptions', {
    method: 'POST',
    body: { endpoint: json.endpoint, keys: json.keys },
  });
  return true;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/notifications/push/subscriptions', {
    method: 'DELETE',
    query: { endpoint: sub.endpoint },
  }).catch(() => undefined);
  await sub.unsubscribe();
}
