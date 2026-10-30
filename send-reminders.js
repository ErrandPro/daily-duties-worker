import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT,
  TEST_PUSH,
} = process.env;

for (const [name, value] of Object.entries({
  SUPABASE_URL,
  SUPABASE_KEY,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT,
})) {
  if (!value) {
    console.error(`Missing secret: ${name}`);
    process.exit(1);
  }
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DEFAULT_TZ = 'Africa/Kampala';
const LATE_WINDOW_MIN = 45; // still deliver up to 45 min late (GitHub can delay runs)
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Current local date, weekday and minutes-since-midnight for a given timezone.
function localTime(timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
  } catch {
    if (timeZone !== DEFAULT_TZ) return localTime(DEFAULT_TZ); // invalid zone: fall back
    throw new Error('Timezone support is not available');
  }
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    tz: timeZone,
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAYS[get('weekday')],
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

// Returns 'ok', 'expired' or 'failed'
async function pushTo(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      { TTL: 3600, urgency: 'high' }
    );
    return 'ok';
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) return 'expired';
    console.error('Push failed:', err.statusCode, err.body || err.message);
    return 'failed';
  }
}

async function removeSub(sub) {
  console.log('Removing expired subscription:', sub.id);
  await supabase.from('push_subscriptions').delete().eq('id', sub.id);
}

async function main() {
  const { data: subs, error: subErr } = await supabase
    .from('push_subscriptions')
    .select('*');
  if (subErr) throw new Error('Could not read push_subscriptions: ' + subErr.message);

  if (!subs || subs.length === 0) {
    console.log('No push subscriptions yet. Enable notifications in the app first.');
    return;
  }

  // Test mode: send one notification to every subscribed device and stop.
  if (TEST_PUSH === 'true') {
    const payload = JSON.stringify({
      title: 'Daily Duties',
      body: 'Test notification. Your reminders are working.',
    });
    let delivered = 0;
    for (const s of subs) {
      const result = await pushTo(s, payload);
      if (result === 'ok') delivered++;
      if (result === 'expired') await removeSub(s);
    }
    console.log(`Test push delivered to ${delivered} of ${subs.length} device(s).`);
    return;
  }

  const { data: reminders, error: remErr } = await supabase
    .from('reminders')
    .select('*')
    .eq('enabled', true);
  if (remErr) throw new Error('Could not read reminders: ' + remErr.message);

  console.log(`${reminders.length} enabled reminder(s), ${subs.length} device(s).`);

  for (const sub of subs) {
    const local = localTime(sub.timezone || DEFAULT_TZ);
    console.log(
      `Device ${sub.id}: ${local.tz}, ${local.date}, ` +
        `${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`
    );

    for (const r of reminders) {
      const days = Array.isArray(r.days) && r.days.length > 0 ? r.days : [0, 1, 2, 3, 4, 5, 6];
      if (!days.includes(local.weekday)) continue;

      const [hh, mm] = String(r.time).slice(0, 5).split(':').map(Number);
      if (Number.isNaN(hh) || Number.isNaN(mm)) {
        console.error(`Skipping "${r.title}": bad time value "${r.time}"`);
        continue;
      }

      const age = local.minutes - (hh * 60 + mm);
      if (age < 0 || age > LATE_WINDOW_MIN) continue; // not due yet, or too late

      // Claim this reminder for this device and local date.
      // The unique constraint blocks duplicates, even if two runs overlap.
      const { error: claimErr } = await supabase.from('reminder_sends').insert({
        reminder_id: r.id,
        subscription_id: sub.id,
        local_date: local.date,
      });
      if (claimErr) {
        if (claimErr.code !== '23505') {
          console.error('Could not record send:', claimErr.message);
        }
        continue; // already sent (or could not claim), skip
      }

      const payload = JSON.stringify({ title: r.title, body: 'Daily Duties reminder' });
      const result = await pushTo(sub, payload);

      if (result === 'ok') {
        console.log(`"${r.title}" sent to device ${sub.id}.`);
        await supabase
          .from('reminders')
          .update({ last_sent_at: new Date().toISOString() })
          .eq('id', r.id);
      } else if (result === 'expired') {
        await removeSub(sub);
        break; // this device is gone, move on to the next one
      } else {
        // Temporary failure: release the claim so the next run retries
        await supabase
          .from('reminder_sends')
          .delete()
          .eq('reminder_id', r.id)
          .eq('subscription_id', sub.id)
          .eq('local_date', local.date);
      }
    }
  }

  // Housekeeping: drop send records older than 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  await supabase.from('reminder_sends').delete().lt('sent_at', cutoff);

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
