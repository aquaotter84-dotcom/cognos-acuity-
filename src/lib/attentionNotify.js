// Autonomy attention → device notification (Android app only).
//
// True push notifications would need a Firebase project plus a sender service,
// which this repo doesn't have. Instead, while the app is running on the phone,
// we poll the attention queue once a minute and raise a local notification when
// new things land that need the user. On the web build this module does nothing.

import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { api } from '@/lib/api';

const SEEN_KEY = 'cognos-attention-seen-v1';
const NOTIF_ID = 1001;
let started = false;

const getSeen = () => {
  try { return Number(localStorage.getItem(SEEN_KEY)) || 0; }
  catch { return 0; }
};
const setSeen = (n) => {
  try { localStorage.setItem(SEEN_KEY, String(n)); } catch { /* private mode */ }
};

async function pollOnce() {
  let data = null;
  try { data = await api.autonomyAttention(); }
  catch { return; } // server unreachable — try again next minute
  const total = data && data.needsAttention ? (data.total || 0) : 0;
  if (total > 0 && total > getSeen()) {
    try {
      await LocalNotifications.schedule({
        notifications: [{
          id: NOTIF_ID,
          title: 'COGNOS',
          body: total === 1
            ? 'One thing on Autonomy needs you.'
            : `${total} things on Autonomy need you.`,
        }],
      });
    } catch { /* notifications unavailable on this device */ }
  }
  setSeen(total);
}

export function startAttentionNotifications() {
  if (started) return;
  started = true;
  let native = false;
  try { native = Capacitor.isNativePlatform(); } catch { native = false; }
  if (!native) return;
  (async () => {
    try {
      const perm = await LocalNotifications.requestPermissions();
      if (perm && perm.display && perm.display !== 'granted') return;
    } catch { return; }
    await pollOnce();
    setInterval(pollOnce, 60_000);
  })();
}
