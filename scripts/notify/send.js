const admin = require('firebase-admin');
const webpush = require('web-push');

const TIMEZONE = 'America/Denver';
const DAILY_HOUR = 8;
const WEEKLY_HOUR = 18;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function localParts(){
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
  });
  const map = {};
  fmt.formatToParts(new Date()).forEach(p => { map[p.type] = p.value; });
  const hour = map.hour === '24' ? 0 : parseInt(map.hour, 10);
  return { isoDate: `${map.year}-${map.month}-${map.day}`, hour };
}

function addDays(iso, n){
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(iso){
  return new Date(iso + 'T00:00:00Z').getUTCDay();
}

function shortLabel(iso){
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function topPriorityTasks(tasks, n){
  return tasks
    .filter(t => !t.done)
    .slice()
    .sort((a, b) => (a.priority - b.priority) || (a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99'))
    .slice(0, n);
}

function dueSuffix(t, todayIso){
  if(!t.dueDate) return '';
  if(t.dueDate === todayIso) return ' — due today';
  if(t.dueDate < todayIso) return ' — overdue';
  return ' — due ' + shortLabel(t.dueDate);
}

async function main(){
  const { isoDate: todayIso, hour } = localParts();
  const isSunday = dayOfWeek(todayIso) === 0;
  const sendDaily = hour === DAILY_HOUR;
  const sendWeekly = isSunday && hour === WEEKLY_HOUR;

  if(!sendDaily && !sendWeekly){
    console.log(`Nothing to send at local hour ${hour} (${todayIso}).`);
    return;
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  const db = admin.database();

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const [todoSnap, subsSnap] = await Promise.all([
    db.ref('projecthub/todoTasks').get(),
    db.ref('projecthubPush').get()
  ]);

  const rawTasks = todoSnap.val();
  const tasks = Array.isArray(rawTasks) ? rawTasks : (rawTasks ? Object.values(rawTasks) : []);
  const subs = subsSnap.val() || {};
  const subEntries = Object.entries(subs);

  if(!subEntries.length){
    console.log('No push subscriptions registered — nothing to send.');
    return;
  }

  let title, body, url;

  if(sendWeekly){
    const sunday = addDays(todayIso, -dayOfWeek(todayIso));
    const nextSunday = addDays(sunday, 7);
    const weekTasks = tasks
      .filter(t => !t.done && t.dueDate && t.dueDate >= sunday && t.dueDate < nextSunday)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (a.priority - b.priority));
    title = 'This Week Ahead';
    body = weekTasks.length
      ? weekTasks.slice(0, 8).map(t => `• ${t.text}${dueSuffix(t, todayIso)}`).join('\n')
      : 'Nothing due this week — clear runway.';
    url = './index.html';
  } else {
    const top = topPriorityTasks(tasks, 5);
    const openCount = tasks.filter(t => !t.done).length;
    title = `Today's To-Do (${openCount} open)`;
    body = top.length
      ? top.map(t => `• ${t.text}${dueSuffix(t, todayIso)}`).join('\n')
      : 'Nothing on your list right now.';
    url = './index.html';
  }

  const payload = JSON.stringify({ title, body, url });

  await Promise.all(subEntries.map(async ([id, sub]) => {
    try{
      await webpush.sendNotification(sub, payload);
      console.log(`Sent to ${id}`);
    }catch(err){
      console.log(`Failed for ${id}: ${err.statusCode || err.message}`);
      if(err.statusCode === 404 || err.statusCode === 410){
        await db.ref('projecthubPush/' + id).remove();
        console.log(`Removed stale subscription ${id}`);
      }
    }
  }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
