import { db, uid, destroyDatabase } from './db.js';
import { getAccount, saveAccount, checkPassword, verifyLogin, isSignedIn, startSession, endSession, REMEMBER_DAYS } from './auth.js';
import { buildReportCard, reportText } from './report.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const FREQUENCIES = {
  weekly: { label: 'Weekly', every: 7 },
  biweekly: { label: 'Every 2 weeks', every: 14 },
  monthly: { label: 'Monthly', every: 30 },
  oncall: { label: 'On call only', every: null },
};

// Typical target ranges. Salt pools use different chlorine / CYA targets.
export const READINGS = [
  { key: 'fc', label: 'Free chlorine', short: 'FC', unit: 'ppm', min: 1, max: 4, salt: { min: 2, max: 4 } },
  { key: 'ph', label: 'pH', short: 'pH', unit: '', min: 7.2, max: 7.8 },
  { key: 'ta', label: 'Alkalinity', short: 'TA', unit: 'ppm', min: 80, max: 120 },
  { key: 'cya', label: 'Stabilizer (CYA)', short: 'CYA', unit: 'ppm', min: 30, max: 50, salt: { min: 60, max: 80 } },
  { key: 'ch', label: 'Calcium hardness', short: 'CH', unit: 'ppm', min: 200, max: 400 },
  { key: 'salt', label: 'Salt', short: 'Salt', unit: 'ppm', min: 2700, max: 3400, saltOnly: true },
  { key: 'temp', label: 'Water temp', short: 'Temp', unit: '°F' },
];

const DEFAULT_SETTINGS = {
  businessName: 'Huber Pools LLC',
  techName: 'Hubert',
  phone: '',
  email: '',
  signoff: 'Thanks for choosing us!',
  checklist: [
    'Skimmed surface',
    'Brushed walls & steps',
    'Vacuumed pool',
    'Emptied skimmer baskets',
    'Emptied pump basket',
    'Checked filter pressure',
    'Tested & balanced water',
    'Checked equipment',
  ],
  chemicals: [
    'Liquid chlorine',
    'Chlorine tabs',
    'Shock',
    'Muriatic acid',
    'Baking soda',
    'Stabilizer (CYA)',
    'Calcium',
    'Salt',
    'Algaecide',
    'Phosphate remover',
  ],
  lastBackup: null,
  installHintDismissed: false,
};

export let settings = { ...DEFAULT_SETTINGS };

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const todayISO = () => localDate();
const parseDay = (iso) => new Date(iso + 'T00:00:00');
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);
const dowOf = (iso) => parseDay(iso).getDay();
function addDays(iso, n) { const d = parseDay(iso); d.setDate(d.getDate() + n); return localDate(d); }

export function fmtDay(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return parseDay(iso).toLocaleDateString(undefined, opts);
}
export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function ago(iso) {
  if (!iso) return 'Never';
  const n = daysBetween(iso, todayISO());
  if (n <= 0) return 'Today';
  if (n === 1) return 'Yesterday';
  return `${n} days ago`;
}
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const digits = (p) => String(p || '').replace(/[^\d+]/g, '');

export function readingStatus(r, value, poolType) {
  if (value === '' || value == null || Number.isNaN(+value)) return '';
  const range = poolType === 'salt' && r.salt ? r.salt : r;
  if (range.min == null) return '';
  if (+value < range.min) return 'low';
  if (+value > range.max) return 'high';
  return 'ok';
}
export function readingsFor(poolType) {
  return READINGS.filter((r) => !r.saltOnly || poolType === 'salt');
}
function rangeText(r, poolType) {
  const range = poolType === 'salt' && r.salt ? r.salt : r;
  return range.min == null ? '' : `${range.min}–${range.max}`;
}

function mapsUrl(addr) {
  const q = encodeURIComponent(addr);
  return isIOS ? `https://maps.apple.com/?daddr=${q}` : `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}
function routeUrl(addresses) {
  if (!addresses.length) return null;
  const dest = addresses[addresses.length - 1];
  const way = addresses.slice(0, -1).slice(0, 9);
  let url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(dest)}`;
  if (way.length) url += `&waypoints=${encodeURIComponent(way.join('|'))}`;
  return url;
}
const smsUrl = (phone, body) => `sms:${digits(phone)}?&body=${encodeURIComponent(body)}`;
const mailUrl = (email, subject, body) =>
  `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// Object URLs for photos shown on the current screen; revoked on navigation.
let objectUrls = [];
function blobUrl(blob) { const u = URL.createObjectURL(blob); objectUrls.push(u); return u; }
function revokeUrls() { objectUrls.forEach((u) => URL.revokeObjectURL(u)); objectUrls = []; }

async function photoUrl(id) {
  const rec = await db.get('photos', id);
  return rec ? blobUrl(rec.blob) : '';
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const u = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(u); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('Could not read that image')); };
    img.src = u;
  });
}
export { loadImage };

// Shrink camera photos (often 4-12 MB) to ~1600px JPEGs so storage lasts.
async function compressImage(file, max = 1600, quality = 0.82) {
  const img = await loadImage(file);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return new Promise((resolve) => c.toBlob((b) => resolve(b || file), 'image/jpeg', quality));
}

function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); return fn(...a); };
  return d;
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
async function loadSettings() {
  const rec = await db.get('settings', 'main');
  settings = { ...DEFAULT_SETTINGS, ...(rec?.value || {}) };
  // The business was renamed; update devices still showing the old default name.
  if (settings.businessName === 'Hubert Pool Service') {
    settings.businessName = DEFAULT_SETTINGS.businessName;
    await saveSettings();
  }
}
async function saveSettings() {
  await db.put('settings', { key: 'main', value: settings });
}

function groupVisits(visits) {
  const map = new Map();
  for (const v of visits) {
    if (!map.has(v.clientId)) map.set(v.clientId, []);
    map.get(v.clientId).push(v);
  }
  for (const list of map.values()) list.sort((a, b) => b.date.localeCompare(a.date));
  return map;
}

// Is this client on the route for `dayISO`? Looks at the last visit before that day.
function isScheduled(client, dayISO, clientVisits) {
  if (client.active === false) return false;
  const f = FREQUENCIES[client.frequency] || FREQUENCIES.weekly;
  if (!f.every) return false;
  if (!(client.days || []).includes(dowOf(dayISO))) return false;
  if (f.every === 7) return true;
  const prev = clientVisits.find((v) => v.day < dayISO);
  if (!prev) return true;
  return daysBetween(prev.day, dayISO) >= f.every - 4;
}

function isOverdue(client, lastVisit) {
  if (client.active === false || !lastVisit) return false;
  const f = FREQUENCIES[client.frequency] || FREQUENCIES.weekly;
  if (!f.every) return false;
  return daysBetween(lastVisit.day, todayISO()) > f.every + 2;
}

const byRouteOrder = (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name);

async function deletePhotos(ids) {
  for (const id of ids) await db.del('photos', id);
}

// ---------------------------------------------------------------------------
// Rendering shell
// ---------------------------------------------------------------------------
const ICONS = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  nav: '<svg viewBox="0 0 24 24"><path d="M3 11 21 3l-8 18-2-8-8-2z"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
  route: '<svg viewBox="0 0 24 24"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
};

function setTopbar({ title, sub, back, right }) {
  $('#topbar').innerHTML = `
    ${back ? `<a class="icon-btn" href="${back}" aria-label="Back">${ICONS.back}</a>` : ''}
    <h1>${esc(title)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</h1>
    ${right || ''}`;
}

function setTab(tab) {
  document.body.classList.toggle('no-tabbar', !tab);
  $$('#tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
let renderToken = 0;
const routes = [
  [/^#\/today(?:\/(\d))?$/, viewToday],
  [/^#\/clients$/, viewClients],
  [/^#\/clients\/new$/, (m, cur) => viewClientForm(null, cur)],
  [/^#\/client\/([\w-]+)$/, (m, cur) => viewClient(m[1], cur)],
  [/^#\/client\/([\w-]+)\/edit$/, (m, cur) => viewClientForm(m[1], cur)],
  [/^#\/service\/([\w-]+)(?:\/([\w-]+))?$/, (m, cur) => viewService(m[1], m[2], cur)],
  [/^#\/visit\/([\w-]+)$/, (m, cur) => viewVisit(m[1], cur)],
  [/^#\/history$/, viewHistory],
  [/^#\/settings$/, viewSettings],
];

let unlocked = false;

async function router() {
  const hash = location.hash || '#/today';
  const token = ++renderToken;
  if (!unlocked) { await viewAuth(); return; }
  document.body.classList.remove('locked');
  const current = () => token === renderToken;
  revokeUrls();
  for (const [re, view] of routes) {
    const m = hash.match(re);
    if (m) {
      try {
        await view(m, current);
      } catch (err) {
        console.error(err);
        $('#app').innerHTML = `<div class="empty"><div class="big">⚠️</div><p>Something went wrong: ${esc(err.message)}</p><a class="btn" href="#/today">Back to Today</a></div>`;
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  location.replace('#/today');
}

// ---------------------------------------------------------------------------
// Today / route
// ---------------------------------------------------------------------------
let reorderMode = false;

async function viewToday(m, current) {
  const today = todayISO();
  const todayDow = new Date().getDay();
  const selDow = m[1] != null ? +m[1] : todayDow;
  const isToday = selDow === todayDow;
  const dayISO = isToday ? today : addDays(today, (selDow - todayDow + 7) % 7);

  const [clients, visits, drafts] = await Promise.all([db.all('clients'), db.all('visits'), db.keys('settings')]);
  if (!current()) return;
  const byClient = groupVisits(visits);
  const draftFor = new Set(drafts.filter((k) => String(k).startsWith('draft:')).map((k) => k.slice(6)));

  const doneOn = new Map();
  for (const v of visits) if (v.day === dayISO && !doneOn.has(v.clientId)) doneOn.set(v.clientId, v);

  const route = clients.filter((c) => isScheduled(c, dayISO, byClient.get(c.id) || [])).sort(byRouteOrder);
  // Extra stops: serviced that day but not on the schedule.
  const extras = clients.filter((c) => doneOn.has(c.id) && !route.includes(c));
  const overdue = isToday
    ? clients.filter((c) => !route.includes(c) && !doneOn.has(c.id) && isOverdue(c, (byClient.get(c.id) || [])[0]))
    : [];

  const doneCount = route.filter((c) => doneOn.has(c.id)).length;
  const remaining = route.filter((c) => !doneOn.has(c.id) && c.address);

  setTab('today');
  setTopbar({
    title: isToday ? 'Today' : DAYS_LONG[selDow],
    sub: fmtDay(dayISO, { weekday: 'long', month: 'long', day: 'numeric' }),
    right: `<a class="icon-btn" href="#/clients/new" aria-label="Add client">${ICONS.plus}</a>`,
  });

  const banners = [];
  if (isIOS && !isStandalone && !settings.installHintDismissed) {
    banners.push(`<div class="banner info"><div><b>Install on your Home Screen</b>Tap <b style="display:inline">Share</b> then <b style="display:inline">Add to Home Screen</b> so the app opens full-screen and keeps your data safe.</div><button class="x" data-dismiss="install" aria-label="Dismiss">×</button></div>`);
  }
  const backupAge = settings.lastBackup ? daysBetween(localDate(new Date(settings.lastBackup)), today) : Infinity;
  if (clients.length && backupAge > 7) {
    banners.push(`<a class="banner" href="#/settings" style="color:inherit"><div><b>Back up your data</b>${settings.lastBackup ? `Last backup was ${backupAge} days ago.` : 'You haven\'t made a backup yet.'} Tap to save a backup file.</div></a>`);
  }

  const stopHtml = (c, i, list, extra = false) => {
    const done = doneOn.get(c.id);
    const flags = [];
    if (extra) flags.push('<span class="badge brand">Extra stop</span>');
    if (c.gateCode) flags.push(`<span class="badge">🔑 ${esc(c.gateCode)}</span>`);
    if (c.poolType === 'salt') flags.push('<span class="badge">Salt</span>');
    if (!done && draftFor.has(c.id)) flags.push('<span class="badge warn">In progress</span>');
    if (done) flags.push(`<span class="badge ok">Done ${fmtTime(done.date)}</span>`);
    if (done && (done.sentAt || done.sentText || done.sentEmail)) flags.push('<span class="badge ok">Report sent</span>');
    else if (done) flags.push('<span class="badge warn">Report not sent</span>');

    let actions;
    if (reorderMode && !extra) {
      actions = `<div class="reorder-btns">
        <button data-move="${c.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
        <button data-move="${c.id}" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
      </div>`;
    } else if (done) {
      actions = `<a class="btn sm ok" href="#/visit/${done.id}">${ICONS.check}View</a>`;
    } else {
      actions = `<div class="stop-actions">
        <a class="btn sm primary" href="#/service/${c.id}">${ICONS.play}Start</a>
        ${c.address ? `<a class="btn sm" href="${mapsUrl(c.address)}" target="_blank" rel="noopener">${ICONS.nav}Go</a>` : ''}
      </div>`;
    }
    return `<div class="stop ${done ? 'done' : ''}">
      <div class="stop-num">${done ? '✓' : extra ? '+' : i + 1}</div>
      <a class="stop-main" href="#/client/${c.id}">
        <div class="stop-name">${esc(c.name)}</div>
        ${c.address ? `<div class="stop-addr">${esc(c.address)}</div>` : ''}
        ${flags.length ? `<div class="badges">${flags.join('')}</div>` : ''}
      </a>
      ${actions}
    </div>`;
  };

  let body = banners.join('');
  body += `<div class="day-bar">${DAYS.map((d, i) => `
    <a class="chip ${i === selDow ? 'on' : ''} ${i === todayDow ? 'today' : ''}" href="#/today/${i}">${d}</a>`).join('')}
  </div>`;

  if (!clients.length) {
    body += `<div class="spacer"></div><div class="empty"><div class="big">🏊</div>
      <p><b>Welcome!</b><br>Add your first client to build your route.</p>
      <a class="btn primary" href="#/clients/new">${ICONS.plus}Add client</a></div>`;
  } else {
    body += `<div class="section"><h2>${route.length} stop${route.length === 1 ? '' : 's'}${isToday ? ` · ${doneCount} done` : ''}</h2>
      ${route.length > 1 ? `<button class="btn sm ghost" id="reorder">${reorderMode ? 'Done' : 'Reorder'}</button>` : ''}</div>`;
    if (isToday && route.length) {
      body += `<div class="progress" style="margin:-4px 0 12px"><div style="width:${Math.round((doneCount / route.length) * 100)}%"></div></div>`;
    }
    if (!route.length) {
      body += `<div class="empty"><div class="big">☀️</div><p>No pools scheduled for ${DAYS_LONG[selDow]}.</p>
        <a class="btn" href="#/clients">Set service days on clients</a></div>`;
    } else {
      body += route.map((c, i) => stopHtml(c, i, route)).join('');
      if (isToday && remaining.length > 1 && !reorderMode) {
        body += `<div class="spacer"></div><a class="btn soft block" href="${routeUrl(remaining.map((c) => c.address))}" target="_blank" rel="noopener">${ICONS.route}Open remaining route in Google Maps</a>`;
      }
    }
    if (extras.length) {
      body += `<div class="section"><h2>Extra stops</h2></div>` + extras.map((c, i) => stopHtml(c, i, extras, true)).join('');
    }
    if (overdue.length) {
      body += `<div class="section"><h2>Overdue</h2></div>`;
      body += overdue.map((c) => {
        const last = byClient.get(c.id)[0];
        return `<div class="stop"><div class="stop-num" style="background:var(--warn-soft);color:var(--warn)">!</div>
          <a class="stop-main" href="#/client/${c.id}"><div class="stop-name">${esc(c.name)}</div>
          <div class="stop-addr">Last serviced ${ago(last.day).toLowerCase()}</div></a>
          <a class="btn sm primary" href="#/service/${c.id}">${ICONS.play}Start</a></div>`;
      }).join('');
    }
  }

  $('#app').innerHTML = body;

  $('#reorder')?.addEventListener('click', () => { reorderMode = !reorderMode; router(); });
  $$('[data-dismiss="install"]').forEach((b) => b.addEventListener('click', async () => {
    settings.installHintDismissed = true;
    await saveSettings();
    b.closest('.banner').remove();
  }));
  $$('[data-move]').forEach((b) => b.addEventListener('click', async () => {
    const idx = route.findIndex((c) => c.id === b.dataset.move);
    const to = idx + +b.dataset.dir;
    [route[idx], route[to]] = [route[to], route[idx]];
    // Re-number this day's stops, keeping their existing order slots.
    const slots = route.map((c) => c.order ?? 1e6).sort((a, b) => a - b);
    const unique = slots.every((s, i) => i === 0 || s > slots[i - 1]) && slots.every((s) => s < 1e6);
    for (let i = 0; i < route.length; i++) {
      route[i].order = unique ? slots[i] : (i + 1) * 10;
      await db.put('clients', route[i]);
    }
    router();
  }));
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
let clientSearch = '';

async function viewClients(m, current) {
  const [clients, visits] = await Promise.all([db.all('clients'), db.all('visits')]);
  if (!current()) return;
  const byClient = groupVisits(visits);
  clients.sort((a, b) => a.name.localeCompare(b.name));

  setTab('clients');
  setTopbar({
    title: 'Clients',
    sub: `${clients.filter((c) => c.active !== false).length} active`,
    right: `<a class="icon-btn" href="#/clients/new" aria-label="Add client">${ICONS.plus}</a>`,
  });

  if (!clients.length) {
    $('#app').innerHTML = `<div class="empty"><div class="big">👥</div><p>No clients yet.</p>
      <a class="btn primary" href="#/clients/new">${ICONS.plus}Add client</a></div>`;
    return;
  }

  const item = (c) => {
    const last = (byClient.get(c.id) || [])[0];
    const f = FREQUENCIES[c.frequency] || FREQUENCIES.weekly;
    const days = (c.days || []).map((d) => DAYS[d]).join(', ');
    const sched = f.every ? (days ? `${days} · ${f.label}` : 'No service day set') : f.label;
    const overdue = isOverdue(c, last);
    return `<a class="list-item" href="#/client/${c.id}" data-search="${esc(`${c.name} ${c.address} ${c.phone} ${c.email}`.toLowerCase())}">
      <div class="avatar">${esc(initials(c.name))}</div>
      <div class="grow">
        <div class="title ellipsis">${esc(c.name)}</div>
        <div class="meta ellipsis">${esc(sched)}</div>
        <div class="meta">Last service: ${overdue ? `<span class="status-text high">${ago(last?.day)}</span>` : ago(last?.day)}</div>
      </div>
      <div class="chev">›</div>
    </a>`;
  };

  const active = clients.filter((c) => c.active !== false);
  const inactive = clients.filter((c) => c.active === false);
  $('#app').innerHTML = `
    <input class="search" type="search" id="search" placeholder="Search name, address, phone" value="${esc(clientSearch)}" autocomplete="off">
    <div class="spacer"></div>
    <div class="list" id="active-list">${active.map(item).join('')}</div>
    ${inactive.length ? `<div class="section"><h2>Inactive</h2></div><div class="list" id="inactive-list">${inactive.map(item).join('')}</div>` : ''}
    <p class="center muted small" id="no-match" hidden>No clients match.</p>`;

  const filter = () => {
    const q = clientSearch.trim().toLowerCase();
    let shown = 0;
    $$('.list-item').forEach((el) => {
      const hit = !q || el.dataset.search.includes(q);
      el.hidden = !hit;
      if (hit) shown++;
    });
    $('#no-match').hidden = shown > 0;
  };
  $('#search').addEventListener('input', (e) => { clientSearch = e.target.value; filter(); });
  filter();
}

async function viewClient(id, current = () => true) {
  const client = await db.get('clients', id);
  if (!current()) return;
  if (!client) { location.replace('#/clients'); return; }
  const visits = (await db.byIndex('visits', 'clientId', id)).sort((a, b) => b.date.localeCompare(a.date));
  if (!current()) return;
  const f = FREQUENCIES[client.frequency] || FREQUENCIES.weekly;

  setTab('clients');
  setTopbar({
    title: client.name,
    sub: client.active === false ? 'Inactive' : f.label,
    back: '#/clients',
    right: `<a class="icon-btn" href="#/client/${id}/edit">Edit</a>`,
  });

  const contact = [];
  if (client.phone) {
    contact.push(`<a class="btn sm" href="tel:${esc(digits(client.phone))}">${ICONS.phone}Call</a>`);
    contact.push(`<a class="btn sm" href="sms:${esc(digits(client.phone))}">${ICONS.text}Text</a>`);
  }
  if (client.email) contact.push(`<a class="btn sm" href="mailto:${esc(client.email)}">${ICONS.mail}Email</a>`);
  if (client.address) contact.push(`<a class="btn sm" href="${mapsUrl(client.address)}" target="_blank" rel="noopener">${ICONS.nav}Directions</a>`);

  const info = [];
  if (client.days?.length && f.every) info.push(['Service days', client.days.map((d) => DAYS[d]).join(', ')]);
  info.push(['Frequency', f.label]);
  info.push(['Pool type', client.poolType === 'salt' ? 'Salt water' : 'Chlorine']);
  if (client.gallons) info.push(['Gallons', Number(client.gallons).toLocaleString()]);
  if (client.rate) info.push(['Rate', `$${client.rate}`]);

  // Latest reading of each type for a quick water-trend glance.
  const last = visits[0];
  const photoIds = [];
  for (const v of visits.slice(0, 30)) photoIds.push(v.photos?.find((p) => p.kind === 'after')?.id || v.photos?.[0]?.id);
  const thumbs = await Promise.all(photoIds.map((pid) => (pid ? photoUrl(pid) : '')));
  if (!current()) return;

  const readingsList = (v) => readingsFor(client.poolType)
    .filter((r) => v.readings?.[r.key] !== '' && v.readings?.[r.key] != null)
    .map((r) => `${r.short} ${v.readings[r.key]}`).join(' · ');

  $('#app').innerHTML = `
    <div class="card stack">
      ${client.address ? `<div><div class="muted tiny">ADDRESS</div><div>${esc(client.address)}</div></div>` : ''}
      ${client.phone || client.email ? `<div><div class="muted tiny">CONTACT</div><div>${esc([client.phone, client.email].filter(Boolean).join(' · '))}</div></div>` : ''}
      ${contact.length ? `<div class="btn-grid">${contact.join('')}</div>` : ''}
    </div>
    ${client.gateCode || client.notes ? `<div class="spacer"></div><div class="callout stack">
      ${client.gateCode ? `<div><div class="label">Gate code</div><div style="font-size:20px;font-weight:800">${esc(client.gateCode)}</div></div>` : ''}
      ${client.notes ? `<div><div class="label">Notes</div><div style="white-space:pre-wrap">${esc(client.notes)}</div></div>` : ''}
    </div>` : ''}
    <div class="spacer"></div>
    <a class="btn primary block big" href="#/service/${id}">${ICONS.play}Start service</a>

    <div class="section"><h2>Pool</h2></div>
    <div class="kv">${info.map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v" style="font-size:16px">${esc(v)}</div></div>`).join('')}</div>

    ${last && Object.values(last.readings || {}).some((x) => x !== '' && x != null) ? `
      <div class="section"><h2>Last water test</h2><span class="muted small">${fmtDay(last.day)}</span></div>
      <div class="kv">${readingsFor(client.poolType).filter((r) => last.readings?.[r.key] !== '' && last.readings?.[r.key] != null).map((r) => {
        const st = readingStatus(r, last.readings[r.key], client.poolType);
        return `<div><div class="k">${r.label}</div><div class="v"><span class="status-text ${st}">${esc(last.readings[r.key])}</span> <span class="tiny muted">${r.unit}</span></div></div>`;
      }).join('')}</div>` : ''}

    <div class="section"><h2>Service history</h2><span class="muted small">${visits.length} visit${visits.length === 1 ? '' : 's'}</span></div>
    ${visits.length ? `<div class="list">${visits.slice(0, 30).map((v, i) => `
      <a class="list-item" href="#/visit/${v.id}">
        ${thumbs[i] ? `<img class="thumb" src="${thumbs[i]}" alt="">` : '<div class="thumb"></div>'}
        <div class="grow">
          <div class="title">${fmtDay(v.day)} <span class="muted small">${fmtTime(v.date)}</span></div>
          <div class="meta ellipsis">${esc(readingsList(v) || v.notes || 'Service logged')}</div>
        </div>
        ${v.sentAt || v.sentText || v.sentEmail ? '<span class="badge ok">Sent</span>' : '<span class="badge warn">Not sent</span>'}
      </a>`).join('')}</div>` : '<p class="muted">No visits yet.</p>'}
  `;
}

async function viewClientForm(id, current = () => true) {
  const existing = id ? await db.get('clients', id) : null;
  if (!current()) return;
  if (id && !existing) { location.replace('#/clients'); return; }
  const c = existing || {
    id: uid(), name: '', phone: '', email: '', address: '',
    days: [], frequency: 'weekly', poolType: 'chlorine', gallons: '', rate: '',
    gateCode: '', notes: '', active: true, createdAt: new Date().toISOString(),
  };

  setTab(null);
  setTopbar({ title: existing ? 'Edit client' : 'New client', back: existing ? `#/client/${id}` : '#/clients' });

  $('#app').innerHTML = `
    <form id="client-form" class="stack" autocomplete="off">
      <div class="card">
        <label class="field"><span>Name *</span><input name="name" required value="${esc(c.name)}" placeholder="e.g. Maria Lopez" autocapitalize="words"></label>
        <label class="field"><span>Mobile phone (for texts)</span><input name="phone" type="tel" inputmode="tel" value="${esc(c.phone)}" placeholder="(555) 123-4567"></label>
        <label class="field"><span>Email</span><input name="email" type="email" inputmode="email" value="${esc(c.email)}" placeholder="name@example.com" autocapitalize="off"></label>
        <label class="field"><span>Address</span><input name="address" value="${esc(c.address)}" placeholder="123 Main St, City" autocapitalize="words"></label>
      </div>

      <div class="card">
        <div class="field"><span>Service day(s)</span>
          <div class="chips wrap" id="days">${DAYS.map((d, i) => `<button type="button" class="chip ${c.days.includes(i) ? 'on' : ''}" data-day="${i}">${d}</button>`).join('')}</div>
        </div>
        <label class="field"><span>How often</span>
          <select name="frequency">${Object.entries(FREQUENCIES).map(([k, f]) => `<option value="${k}" ${c.frequency === k ? 'selected' : ''}>${f.label}</option>`).join('')}</select>
        </label>
      </div>

      <div class="card">
        <div class="grid2">
          <label class="field"><span>Pool type</span>
            <select name="poolType">
              <option value="chlorine" ${c.poolType !== 'salt' ? 'selected' : ''}>Chlorine</option>
              <option value="salt" ${c.poolType === 'salt' ? 'selected' : ''}>Salt water</option>
            </select>
          </label>
          <label class="field"><span>Gallons</span><input name="gallons" inputmode="numeric" value="${esc(c.gallons)}" placeholder="15000"></label>
        </div>
        <div class="grid2" style="margin-top:12px">
          <label class="field"><span>Gate code</span><input name="gateCode" value="${esc(c.gateCode)}" placeholder="#1234"></label>
          <label class="field"><span>Rate ($/visit)</span><input name="rate" inputmode="decimal" value="${esc(c.rate)}" placeholder="45"></label>
        </div>
        <label class="field" style="margin-top:12px"><span>Notes (dogs, equipment, access…)</span><textarea name="notes" placeholder="Dog in backyard. Pump is Pentair SuperFlo.">${esc(c.notes)}</textarea></label>
        <div class="switch-row" style="margin-top:8px"><span>Active client</span>
          <label class="switch"><input type="checkbox" name="active" ${c.active !== false ? 'checked' : ''}><i></i></label></div>
      </div>

      ${existing ? `<button type="button" class="btn danger block" id="delete">Delete client</button>` : ''}
      <div class="sticky-footer"><div class="inner">
        <a class="btn" href="${existing ? `#/client/${id}` : '#/clients'}">Cancel</a>
        <button class="btn primary" type="submit">Save client</button>
      </div></div>
    </form>`;

  const days = new Set(c.days);
  $$('#days [data-day]').forEach((b) => b.addEventListener('click', () => {
    const d = +b.dataset.day;
    days.has(d) ? days.delete(d) : days.add(d);
    b.classList.toggle('on', days.has(d));
  }));

  $('#client-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = fd.get('name').trim();
    if (!name) { toast('Please enter a name'); return; }
    Object.assign(c, {
      name,
      phone: fd.get('phone').trim(),
      email: fd.get('email').trim(),
      address: fd.get('address').trim(),
      days: [...days].sort(),
      frequency: fd.get('frequency'),
      poolType: fd.get('poolType'),
      gallons: fd.get('gallons').trim(),
      rate: fd.get('rate').trim(),
      gateCode: fd.get('gateCode').trim(),
      notes: fd.get('notes').trim(),
      active: fd.get('active') === 'on',
      updatedAt: new Date().toISOString(),
    });
    if (c.order == null) {
      const all = await db.all('clients');
      c.order = (Math.max(0, ...all.map((x) => x.order || 0)) || 0) + 10;
    }
    await db.put('clients', c);
    toast('Client saved');
    location.hash = `#/client/${c.id}`;
  });

  $('#delete')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${c.name} and all of their service history and photos? This can't be undone.`)) return;
    const visits = await db.byIndex('visits', 'clientId', c.id);
    for (const v of visits) {
      await deletePhotos((v.photos || []).map((p) => p.id));
      await db.del('visits', v.id);
    }
    await db.del('settings', 'draft:' + c.id);
    await db.del('clients', c.id);
    toast('Client deleted');
    location.hash = '#/clients';
  });
}

// ---------------------------------------------------------------------------
// Service form (new visit or edit)
// ---------------------------------------------------------------------------
async function viewService(clientId, visitId, current = () => true) {
  const client = await db.get('clients', clientId);
  if (!client) { location.replace('#/today'); return; }
  const original = visitId ? await db.get('visits', visitId) : null;
  const draftKey = visitId ? `draft-edit:${visitId}` : `draft:${clientId}`;
  const savedDraft = (await db.get('settings', draftKey))?.value;
  if (!current()) return;

  // Previous visit (for "last time" hints on readings).
  const history = (await db.byIndex('visits', 'clientId', clientId))
    .filter((v) => v.id !== visitId).sort((a, b) => b.date.localeCompare(a.date));
  const prev = history[0];

  const fresh = () => ({
    checklist: Object.fromEntries(settings.checklist.map((item) => [item, true])),
    readings: {},
    chemicals: [],
    notes: '',
    photos: [],
    addedPhotoIds: [],
  });
  const draft = savedDraft || (original ? { ...structuredClone(original), addedPhotoIds: [] } : fresh());
  // Make sure every current checklist item shows up.
  for (const item of settings.checklist) if (!(item in draft.checklist)) draft.checklist[item] = false;

  const persist = debounce(() => db.put('settings', { key: draftKey, value: draft }), 300);

  setTab(null);
  setTopbar({
    title: client.name,
    sub: original ? `Editing ${fmtDay(original.day)}` : 'Service visit',
    back: original ? `#/visit/${visitId}` : `#/client/${clientId}`,
  });

  const poolReadings = readingsFor(client.poolType);

  $('#app').innerHTML = `
    ${savedDraft ? `<div class="banner info"><div><b>Unsaved visit restored</b>Pick up where you left off.</div><button class="x" id="discard" aria-label="Discard draft" title="Discard">Discard</button></div>` : ''}
    ${client.gateCode || client.notes ? `<div class="callout stack">
      ${client.gateCode ? `<div><span class="label">Gate code</span> <b style="font-size:18px">${esc(client.gateCode)}</b></div>` : ''}
      ${client.notes ? `<div style="white-space:pre-wrap">${esc(client.notes)}</div>` : ''}
    </div>` : ''}

    <div class="section"><h2>Photos</h2></div>
    <div class="card" id="photos"></div>

    <div class="section"><h2>Checklist</h2><button type="button" class="btn sm ghost" id="check-all">All</button></div>
    <div class="chips wrap" id="checklist">${Object.keys(draft.checklist).map((item) => `
      <button type="button" class="chip check-chip ${draft.checklist[item] ? 'on' : ''}" data-item="${esc(item)}">${esc(item)}</button>`).join('')}
    </div>

    <div class="section"><h2>Water test</h2><span class="muted tiny">${client.poolType === 'salt' ? 'Salt pool targets' : 'Target ranges'}</span></div>
    <div class="readings">${poolReadings.map((r) => {
      const val = draft.readings[r.key] ?? '';
      const st = readingStatus(r, val, client.poolType);
      const last = prev?.readings?.[r.key];
      return `<div class="reading ${st}" data-reading="${r.key}">
        <span class="dot ${st}"></span>
        <label for="r-${r.key}">${r.label}${r.unit ? ` <span class="tiny">(${r.unit})</span>` : ''}</label>
        <input id="r-${r.key}" type="text" inputmode="decimal" value="${esc(val)}" placeholder="–" autocomplete="off">
        <div class="hint">${rangeText(r, client.poolType) ? `Ideal ${rangeText(r, client.poolType)}` : ''}${last != null && last !== '' ? `${rangeText(r, client.poolType) ? ' · ' : ''}Last ${esc(last)}` : ''}</div>
      </div>`;
    }).join('')}</div>

    <div class="section"><h2>Chemicals added</h2></div>
    <div class="card">
      <div id="chems"></div>
      <div class="chips wrap" style="margin-top:10px" id="chem-quick">${settings.chemicals.map((ch) => `<button type="button" class="chip" data-chem="${esc(ch)}">+ ${esc(ch)}</button>`).join('')}</div>
      <datalist id="chem-list">${settings.chemicals.map((ch) => `<option value="${esc(ch)}">`).join('')}</datalist>
    </div>

    <div class="section"><h2>Notes for customer</h2></div>
    <label class="field"><textarea id="notes" placeholder="e.g. Filter pressure high — recommend a filter clean next visit.">${esc(draft.notes)}</textarea></label>

    <div class="sticky-footer"><div class="inner">
      <button class="btn primary big" id="save">${ICONS.check}${original ? 'Save changes' : 'Finish & send report'}</button>
    </div></div>`;

  // ----- Photos -----
  const renderPhotos = async () => {
    const urls = await Promise.all(draft.photos.map((p) => photoUrl(p.id)));
    const section = (kind, label) => {
      const items = draft.photos.map((p, i) => ({ ...p, url: urls[i] })).filter((p) => p.kind === kind);
      return `<div class="photo-kind"><h3>${label}
          <label>From library<input type="file" accept="image/*" multiple data-kind="${kind}"></label></h3>
        <div class="photo-grid">
          ${items.map((p) => `<div class="photo"><img src="${p.url}" alt="${label} photo" data-full="${p.id}"><button type="button" class="remove" data-remove="${p.id}" aria-label="Remove photo">×</button></div>`).join('')}
          <label class="add-photo">${ICONS.camera}Take photo<input type="file" accept="image/*" capture="environment" data-kind="${kind}"></label>
        </div></div>`;
    };
    $('#photos').innerHTML = section('after', 'After (sent to customer)') + section('before', 'Before (optional)');
    $$('#photos input[type=file]').forEach((inp) => inp.addEventListener('change', async () => {
      const files = [...inp.files];
      inp.value = '';
      for (const file of files) {
        try {
          const blob = await compressImage(file);
          const id = uid();
          await db.put('photos', { id, blob, createdAt: new Date().toISOString() });
          draft.photos.push({ id, kind: inp.dataset.kind });
          draft.addedPhotoIds.push(id);
          await persist.flush();
        } catch (err) {
          toast(err.message);
        }
      }
      renderPhotos();
    }));
    $$('#photos [data-remove]').forEach((b) => b.addEventListener('click', () => {
      draft.photos = draft.photos.filter((p) => p.id !== b.dataset.remove);
      persist();
      renderPhotos();
    }));
  };
  renderPhotos();

  // ----- Checklist -----
  $$('#checklist [data-item]').forEach((b) => b.addEventListener('click', () => {
    const item = b.dataset.item;
    draft.checklist[item] = !draft.checklist[item];
    b.classList.toggle('on', draft.checklist[item]);
    persist();
  }));
  $('#check-all').addEventListener('click', () => {
    const allOn = Object.values(draft.checklist).every(Boolean);
    for (const k of Object.keys(draft.checklist)) draft.checklist[k] = !allOn;
    $$('#checklist [data-item]').forEach((b) => b.classList.toggle('on', !allOn));
    persist();
  });

  // ----- Readings -----
  $$('[data-reading]').forEach((box) => {
    const r = READINGS.find((x) => x.key === box.dataset.reading);
    const input = $('input', box);
    input.addEventListener('input', () => {
      const v = input.value.replace(',', '.').trim();
      draft.readings[r.key] = v;
      const st = readingStatus(r, v, client.poolType);
      box.className = `reading ${st}`;
      $('.dot', box).className = `dot ${st}`;
      persist();
    });
  });

  // ----- Chemicals -----
  const renderChems = () => {
    $('#chems').innerHTML = draft.chemicals.length
      ? draft.chemicals.map((ch, i) => `<div class="chem-row">
          <input class="input" list="chem-list" data-chem-name="${i}" value="${esc(ch.name)}" placeholder="Chemical">
          <input class="input" data-chem-amt="${i}" value="${esc(ch.amount)}" placeholder="Amount">
          <button type="button" class="remove-btn" data-chem-del="${i}" aria-label="Remove">×</button>
        </div>`).join('')
      : '<p class="muted small" style="margin:0">Tap a chemical below to add it.</p>';
    $$('[data-chem-name]').forEach((inp) => inp.addEventListener('input', () => { draft.chemicals[+inp.dataset.chemName].name = inp.value; persist(); }));
    $$('[data-chem-amt]').forEach((inp) => inp.addEventListener('input', () => { draft.chemicals[+inp.dataset.chemAmt].amount = inp.value; persist(); }));
    $$('[data-chem-del]').forEach((b) => b.addEventListener('click', () => { draft.chemicals.splice(+b.dataset.chemDel, 1); persist(); renderChems(); }));
  };
  renderChems();
  $$('#chem-quick [data-chem]').forEach((b) => b.addEventListener('click', () => {
    draft.chemicals.push({ name: b.dataset.chem, amount: '' });
    persist();
    renderChems();
    $(`[data-chem-amt="${draft.chemicals.length - 1}"]`)?.focus();
  }));

  $('#notes').addEventListener('input', (e) => { draft.notes = e.target.value; persist(); });

  $('#discard')?.addEventListener('click', async () => {
    if (!confirm('Discard this unsaved visit?')) return;
    const keep = new Set((original?.photos || []).map((p) => p.id));
    await deletePhotos(draft.addedPhotoIds.filter((pid) => !keep.has(pid)));
    await db.del('settings', draftKey);
    router();
  });

  // ----- Save -----
  $('#save').addEventListener('click', async () => {
    const btn = $('#save');
    btn.disabled = true;
    try {
      const now = new Date();
      const visit = {
        ...(original || {}),
        id: original?.id || uid(),
        clientId,
        date: original?.date || now.toISOString(),
        day: original?.day || localDate(now),
        checklist: draft.checklist,
        readings: Object.fromEntries(Object.entries(draft.readings).filter(([, v]) => v !== '')),
        chemicals: draft.chemicals.filter((c) => c.name.trim()),
        notes: draft.notes.trim(),
        photos: draft.photos,
        poolType: client.poolType,
        updatedAt: now.toISOString(),
      };
      // Remove photos that were taken off the visit.
      const final = new Set(visit.photos.map((p) => p.id));
      const candidates = [...(original?.photos || []).map((p) => p.id), ...draft.addedPhotoIds];
      await deletePhotos(candidates.filter((pid) => !final.has(pid)));
      await db.put('visits', visit);
      await db.del('settings', draftKey);
      toast(original ? 'Visit updated' : 'Visit saved');
      location.hash = `#/visit/${visit.id}`;
    } catch (err) {
      btn.disabled = false;
      toast('Could not save: ' + err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Visit detail + send report
// ---------------------------------------------------------------------------
async function viewVisit(id, current = () => true) {
  const visit = await db.get('visits', id);
  if (!current()) return;
  if (!visit) { location.replace('#/history'); return; }
  const client = (await db.get('clients', visit.clientId)) || { name: 'Deleted client', poolType: visit.poolType };

  setTab(null);
  setTopbar({
    title: client.name,
    sub: `${fmtDay(visit.day, { weekday: 'long', month: 'short', day: 'numeric' })} · ${fmtTime(visit.date)}`,
    back: client.id ? `#/client/${client.id}` : '#/history',
    right: client.id ? `<a class="icon-btn" href="#/service/${client.id}/${id}">Edit</a>` : '',
  });

  const text = reportText(visit, client, settings);
  const subject = `Pool service report – ${fmtDay(visit.day, { weekday: 'short', month: 'short', day: 'numeric' })}`;
  const photoUrls = await Promise.all((visit.photos || []).map((p) => photoUrl(p.id)));
  if (!current()) return;

  const sentBits = [];
  if (visit.sentAt) sentBits.push(`Shared ${fmtDay(localDate(new Date(visit.sentAt)))} ${fmtTime(visit.sentAt)}`);
  if (visit.sentText) sentBits.push(`Text opened ${fmtTime(visit.sentText)}`);
  if (visit.sentEmail) sentBits.push(`Email opened ${fmtTime(visit.sentEmail)}`);

  const checks = Object.entries(visit.checklist || {}).filter(([, v]) => v).map(([k]) => k);
  const readings = readingsFor(client.poolType).filter((r) => visit.readings?.[r.key] != null && visit.readings[r.key] !== '');

  $('#app').innerHTML = `
    <div class="section"><h2>Send to customer</h2>${sentBits.length ? '<span class="badge ok">Sent</span>' : '<span class="badge warn">Not sent yet</span>'}</div>
    <div class="card stack">
      <button class="btn primary block big" id="share" disabled>${ICONS.share}Send photo report</button>
      <p class="muted small" style="margin:6px 2px 0">Opens your phone's share menu. Pick <b>Messages</b> or <b>Mail</b>, then choose ${esc(client.name.split(' ')[0])}.
        ${client.phone ? `Their number is <b>${esc(client.phone)}</b>.` : ''}</p>
      <div class="btn-grid">
        ${client.phone ? `<a class="btn" id="sms" href="${smsUrl(client.phone, text)}">${ICONS.text}Text</a>` : ''}
        ${client.email ? `<a class="btn" id="mail" href="${mailUrl(client.email, subject, text)}">${ICONS.mail}Email</a>` : ''}
        <button class="btn" id="save-img" disabled>${ICONS.download}Save image</button>
      </div>
      <p class="muted tiny" style="margin:4px 2px 0"><b>Text</b> and <b>Email</b> open a message already addressed to the customer with the written summary. To add the photo there too, tap <b>Save image</b> first and attach it from your camera roll.</p>
      ${sentBits.length ? `<p class="tiny ok status-text ok" style="margin:0">${sentBits.map(esc).join(' · ')}</p>` : ''}
      <button class="btn ghost sm" id="mark-sent">${sentBits.length ? 'Mark as not sent' : 'Mark as sent'}</button>
    </div>

    <div class="section"><h2>Report preview</h2></div>
    <img class="report-preview" id="preview" alt="Service report preview">

    ${photoUrls.length ? `<div class="section"><h2>Photos</h2></div>
      <div class="photo-grid">${visit.photos.map((p, i) => `<div class="photo"><img src="${photoUrls[i]}" alt="" data-src="${photoUrls[i]}"><span class="tag">${p.kind}</span></div>`).join('')}</div>` : ''}

    ${readings.length ? `<div class="section"><h2>Water test</h2></div>
      <div class="kv">${readings.map((r) => {
        const st = readingStatus(r, visit.readings[r.key], client.poolType);
        return `<div><div class="k">${r.label}</div><div class="v"><span class="status-text ${st}">${esc(visit.readings[r.key])}</span> <span class="tiny muted">${r.unit}</span></div></div>`;
      }).join('')}</div>` : ''}

    ${visit.chemicals?.length ? `<div class="section"><h2>Chemicals added</h2></div>
      <div class="list">${visit.chemicals.map((c) => `<div class="list-item" style="min-height:48px"><div class="grow">${esc(c.name)}</div><b>${esc(c.amount)}</b></div>`).join('')}</div>` : ''}

    ${checks.length ? `<div class="section"><h2>Completed</h2></div>
      <div class="chips wrap">${checks.map((c) => `<span class="chip check-chip on" style="cursor:default">${esc(c)}</span>`).join('')}</div>` : ''}

    ${visit.notes ? `<div class="section"><h2>Notes</h2></div><div class="card" style="white-space:pre-wrap">${esc(visit.notes)}</div>` : ''}

    <div class="spacer"></div><div class="spacer"></div>
    <button class="btn danger block" id="delete-visit">Delete this visit</button>
  `;

  $$('.photo img').forEach((img) => img.addEventListener('click', () => openLightbox(img.src)));

  const markSent = async (field) => {
    visit[field] = new Date().toISOString();
    await db.put('visits', visit);
  };

  // Build the report image up front so the share button responds instantly
  // (iOS only allows the share sheet directly from a tap).
  let card;
  try {
    card = await buildReportCard(visit, client, settings);
  } catch (err) {
    console.error(err);
    toast('Could not build report image');
  }
  if (!current()) return;
  const fileName = `pool-service-${visit.day}.jpg`;
  if (card) {
    const cardUrl = blobUrl(card);
    $('#preview').src = cardUrl;
    $('#preview').addEventListener('click', () => openLightbox(cardUrl));
    $('#share').disabled = false;
    $('#save-img').disabled = false;
  }

  $('#share').addEventListener('click', async () => {
    const file = new File([card], fileName, { type: 'image/jpeg' });
    const data = { files: [file], title: subject, text };
    if (navigator.canShare?.(data)) {
      try {
        await navigator.share(data);
        await markSent('sentAt');
        toast('Report sent');
        router();
      } catch (err) {
        if (err.name !== 'AbortError') toast('Sharing failed: ' + err.message);
      }
    } else if (navigator.share) {
      // Some browsers can't share files — share the text summary instead.
      try { await navigator.share({ title: subject, text }); await markSent('sentAt'); router(); } catch { /* cancelled */ }
    } else {
      downloadBlob(card, fileName);
      toast('This browser can\'t share — image downloaded instead');
    }
  });

  $('#save-img').addEventListener('click', async () => {
    const file = new File([card], fileName, { type: 'image/jpeg' });
    // On phones "Save Image" lives in the share sheet.
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch { /* cancelled */ }
    } else {
      downloadBlob(card, fileName);
    }
  });

  $('#sms')?.addEventListener('click', () => markSent('sentText'));
  $('#mail')?.addEventListener('click', () => markSent('sentEmail'));
  $('#mark-sent').addEventListener('click', async () => {
    if (sentBits.length) {
      delete visit.sentAt; delete visit.sentText; delete visit.sentEmail;
      await db.put('visits', visit);
    } else {
      await markSent('sentAt');
    }
    router();
  });

  $('#delete-visit').addEventListener('click', async () => {
    if (!confirm('Delete this visit and its photos?')) return;
    await deletePhotos((visit.photos || []).map((p) => p.id));
    await db.del('visits', visit.id);
    toast('Visit deleted');
    location.hash = client.id ? `#/client/${client.id}` : '#/history';
  });
}

function openLightbox(src) {
  const lb = $('#lightbox');
  $('img', lb).src = src;
  lb.hidden = false;
}
$('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
let historyFilter = 'all';
let historyLimit = 60;

async function viewHistory(m, current) {
  const [visits, clients] = await Promise.all([db.all('visits'), db.all('clients')]);
  if (!current()) return;
  const clientById = new Map(clients.map((c) => [c.id, c]));
  visits.sort((a, b) => b.date.localeCompare(a.date));

  const today = todayISO();
  const weekStart = addDays(today, -new Date().getDay());
  const monthStart = today.slice(0, 8) + '01';
  const isSent = (v) => v.sentAt || v.sentText || v.sentEmail;
  const thisWeek = visits.filter((v) => v.day >= weekStart).length;
  const thisMonth = visits.filter((v) => v.day >= monthStart);
  const unsent = visits.filter((v) => !isSent(v));
  const monthRevenue = thisMonth.reduce((sum, v) => sum + (parseFloat(clientById.get(v.clientId)?.rate) || 0), 0);

  setTab('history');
  setTopbar({ title: 'History', sub: `${visits.length} visit${visits.length === 1 ? '' : 's'} logged` });

  const list = (historyFilter === 'unsent' ? unsent : visits).slice(0, historyLimit);
  const thumbs = await Promise.all(list.map((v) => {
    const p = v.photos?.find((x) => x.kind === 'after') || v.photos?.[0];
    return p ? photoUrl(p.id) : '';
  }));
  if (!current()) return;

  let html = `<div class="stats">
      <div class="stat"><div class="n">${thisWeek}</div><div class="l">This week</div></div>
      <div class="stat"><div class="n">${thisMonth.length}</div><div class="l">This month</div></div>
      <div class="stat"><div class="n">${monthRevenue ? '$' + Math.round(monthRevenue).toLocaleString() : '—'}</div><div class="l">Month billed*</div></div>
    </div>
    <p class="tiny muted" style="margin:6px 2px 0">*Based on each client's rate per visit.</p>
    <div class="spacer"></div>
    <div class="chips">
      <button class="chip ${historyFilter === 'all' ? 'on' : ''}" data-filter="all">All visits</button>
      <button class="chip ${historyFilter === 'unsent' ? 'on' : ''}" data-filter="unsent">Report not sent (${unsent.length})</button>
    </div>`;

  if (!list.length) {
    html += `<div class="spacer"></div><div class="empty"><div class="big">📋</div><p>${historyFilter === 'unsent' ? 'All reports have been sent. Nice!' : 'No visits logged yet.'}</p></div>`;
  } else {
    let lastDay = '';
    let open = false;
    list.forEach((v, i) => {
      if (v.day !== lastDay) {
        if (open) html += '</div>';
        html += `<div class="day-head">${v.day === today ? 'Today' : fmtDay(v.day, { weekday: 'long', month: 'short', day: 'numeric' })}</div><div class="list">`;
        open = true;
        lastDay = v.day;
      }
      const c = clientById.get(v.clientId);
      html += `<a class="list-item" href="#/visit/${v.id}">
        ${thumbs[i] ? `<img class="thumb" src="${thumbs[i]}" alt="">` : '<div class="thumb"></div>'}
        <div class="grow"><div class="title ellipsis">${esc(c?.name || 'Deleted client')}</div>
          <div class="meta">${fmtTime(v.date)}${v.chemicals?.length ? ` · ${v.chemicals.length} chemical${v.chemicals.length > 1 ? 's' : ''}` : ''}</div></div>
        ${isSent(v) ? '<span class="badge ok">Sent</span>' : '<span class="badge warn">Not sent</span>'}
      </a>`;
    });
    if (open) html += '</div>';
    const total = historyFilter === 'unsent' ? unsent.length : visits.length;
    if (total > list.length) html += `<div class="spacer"></div><button class="btn block" id="more">Show more</button>`;
  }

  $('#app').innerHTML = html;
  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => { historyFilter = b.dataset.filter; historyLimit = 60; router(); }));
  $('#more')?.addEventListener('click', () => { historyLimit += 60; router(); });
}

// ---------------------------------------------------------------------------
// Settings + backup
// ---------------------------------------------------------------------------
async function viewSettings(m, current) {
  const [clients, visits, photoKeys, account] = await Promise.all([db.keys('clients'), db.keys('visits'), db.keys('photos'), getAccount()]);
  let usage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage) usage = `${(est.usage / 1024 / 1024).toFixed(1)} MB used`;
  } catch { /* not supported */ }
  let persisted = false;
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* not supported */ }
  if (!current()) return;

  setTab('settings');
  setTopbar({ title: 'Settings' });

  $('#app').innerHTML = `
    <form id="settings-form" autocomplete="off">
      <div class="section"><h2>Business</h2></div>
      <div class="card">
        <label class="field"><span>Business name</span><input name="businessName" value="${esc(settings.businessName)}"></label>
        <label class="field"><span>Your name</span><input name="techName" value="${esc(settings.techName)}"></label>
        <div class="grid2" style="margin-top:12px">
          <label class="field"><span>Phone</span><input name="phone" type="tel" value="${esc(settings.phone)}"></label>
          <label class="field"><span>Email</span><input name="email" type="email" value="${esc(settings.email)}" autocapitalize="off"></label>
        </div>
        <label class="field" style="margin-top:12px"><span>Report sign-off</span><input name="signoff" value="${esc(settings.signoff)}"></label>
      </div>

      <div class="section"><h2>Service checklist</h2></div>
      <label class="field"><textarea name="checklist" rows="8">${esc(settings.checklist.join('\n'))}</textarea></label>
      <p class="tiny muted" style="margin:4px 2px 0">One task per line.</p>

      <div class="section"><h2>Chemical shortcuts</h2></div>
      <label class="field"><textarea name="chemicals" rows="8">${esc(settings.chemicals.join('\n'))}</textarea></label>
      <p class="tiny muted" style="margin:4px 2px 0">One chemical per line.</p>
      <div class="spacer"></div>
      <button class="btn primary block" type="submit">Save settings</button>
    </form>

    <div class="section"><h2>Account</h2></div>
    <div class="card stack">
      <p class="small" style="margin:0">Signed in as <b>${esc(account?.username || '')}</b>.</p>
      <button class="btn block" id="change-login">Change username or password</button>
      <form id="login-form" class="stack" hidden autocomplete="on">
        <label class="field"><span>Username</span><input name="username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(account?.username || '')}" required></label>
        <label class="field"><span>Current password</span><input name="current" type="password" autocomplete="current-password" required></label>
        <label class="field"><span>New password <span class="tiny">(leave blank to keep the current one)</span></span><input name="password" type="password" autocomplete="new-password" minlength="6"></label>
        <label class="field"><span>Confirm new password</span><input name="confirm" type="password" autocomplete="new-password"></label>
        <button class="btn primary block" type="submit">Save login</button>
      </form>
      <button class="btn danger block" id="sign-out">Sign out</button>
    </div>

    <div class="section"><h2>Backup</h2></div>
    <div class="card stack">
      <p class="small" style="margin:0">Everything is stored on this phone only: ${clients.length} clients, ${visits.length} visits, ${photoKeys.length} photos${usage ? ` (${usage})` : ''}.
      ${settings.lastBackup ? `Last backup: <b>${fmtDay(localDate(new Date(settings.lastBackup)))}</b>.` : '<b>No backup yet.</b>'}</p>
      <p class="small muted" style="margin:0">Save a backup every week or so (for example to iCloud Drive or Google Drive). It's also how you move your data to a new phone.</p>
      <button class="btn primary block" id="export">${ICONS.download}Save backup file</button>
      <label class="btn block">Restore from backup<input type="file" accept=".json,application/json" id="import" hidden></label>
      ${persisted ? '<p class="tiny status-text ok" style="margin:0">✓ Storage is protected from automatic cleanup.</p>' : ''}
    </div>

    <div class="section"><h2>About</h2></div>
    <div class="card small">
      <p style="margin:0 0 8px"><b>${esc(settings.businessName)}</b> · works offline.</p>
      <p class="muted" style="margin:0">${isStandalone ? 'Running as an installed app.' : isIOS
        ? 'Tip: in Safari tap Share → Add to Home Screen to install.'
        : 'Tip: use your browser menu → Install app / Add to Home screen.'}</p>
    </div>`;

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
    Object.assign(settings, {
      businessName: fd.get('businessName').trim() || DEFAULT_SETTINGS.businessName,
      techName: fd.get('techName').trim(),
      phone: fd.get('phone').trim(),
      email: fd.get('email').trim(),
      signoff: fd.get('signoff').trim(),
      checklist: lines(fd.get('checklist')),
      chemicals: lines(fd.get('chemicals')),
    });
    await saveSettings();
    toast('Settings saved');
  });

  $('#change-login').addEventListener('click', () => {
    $('#login-form').hidden = false;
    $('#change-login').hidden = true;
    $('#login-form [name=current]').focus();
  });
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const username = fd.get('username').trim();
    const password = fd.get('password');
    if (!username) { toast('Enter a username'); return; }
    if (!(await checkPassword(fd.get('current')))) { toast('Current password is incorrect'); return; }
    if (password && password.length < 6) { toast('New password must be at least 6 characters'); return; }
    if (password !== fd.get('confirm')) { toast('New passwords don\'t match'); return; }
    await saveAccount(username, password || fd.get('current'));
    toast('Login updated');
    router();
  });
  $('#sign-out').addEventListener('click', async () => {
    await endSession();
    unlocked = false;
    router();
  });

  $('#export').addEventListener('click', exportBackup);
  $('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importBackup(file);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function exportBackup() {
  const btn = $('#export');
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const [clients, visits, photos] = await Promise.all([db.all('clients'), db.all('visits'), db.all('photos')]);
    const data = {
      app: 'hubert-pool-service',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      clients,
      visits,
      photos: await Promise.all(photos.map(async (p) => ({ id: p.id, createdAt: p.createdAt, data: await blobToDataUrl(p.blob) }))),
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const name = `pool-service-backup-${todayISO()}.json`;
    const file = new File([blob], name, { type: 'application/json' });
    let done = false;
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); done = true; } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    if (!done) downloadBlob(blob, name);
    settings.lastBackup = new Date().toISOString();
    await saveSettings();
    toast('Backup saved');
    router();
  } catch (err) {
    toast('Backup failed: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('That file isn\'t a valid backup');
    return;
  }
  if (data.app !== 'hubert-pool-service') { toast('That file isn\'t a Huber Pools backup'); return; }
  if (!confirm(`Restore ${data.clients.length} clients and ${data.visits.length} visits from ${new Date(data.exportedAt).toLocaleDateString()}? Records with the same ID will be replaced.`)) return;
  for (const p of data.photos || []) {
    const blob = await (await fetch(p.data)).blob();
    await db.put('photos', { id: p.id, createdAt: p.createdAt, blob });
  }
  for (const c of data.clients || []) await db.put('clients', c);
  for (const v of data.visits || []) await db.put('visits', v);
  if (data.settings) {
    settings = { ...DEFAULT_SETTINGS, ...data.settings, lastBackup: settings.lastBackup || data.settings.lastBackup };
    await saveSettings();
  }
  toast('Backup restored');
  location.hash = '#/today';
  router();
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
async function viewAuth(mode) {
  const account = await getAccount();
  mode = mode || (account ? 'login' : 'setup');
  document.body.classList.add('locked');
  setTab(null);
  $('#topbar').innerHTML = '';

  const brand = `<div class="auth-brand">
      <img src="icons/icon-192.png" alt="" width="72" height="72">
      <h1>${esc(settings.businessName)}</h1>
    </div>`;
  const showPw = `<label class="row small muted" style="gap:8px;margin-top:10px"><input type="checkbox" id="show-pw"> Show password</label>`;

  let html;
  if (mode === 'setup') {
    html = `${brand}
      <form class="card stack" id="auth-form" autocomplete="on">
        <div><h2 style="font-size:20px">Create your login</h2>
        <p class="muted small" style="margin:6px 0 0">You'll use this to open the app. It's saved on this device only.</p></div>
        <label class="field"><span>Username</span><input name="username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required></label>
        <label class="field"><span>Password <span class="tiny">(at least 6 characters)</span></span><input name="password" type="password" autocomplete="new-password" minlength="6" required></label>
        <label class="field"><span>Confirm password</span><input name="confirm" type="password" autocomplete="new-password" required></label>
        ${showPw}
        <button class="btn primary block big" type="submit">Create login</button>
      </form>`;
  } else if (mode === 'forgot') {
    html = `${brand}
      <div class="card stack">
        <h2 style="font-size:20px">Forgot your password?</h2>
        <p class="small" style="margin:0">For privacy, your password isn't stored anywhere it can be recovered from, and there's no server to reset it.</p>
        <p class="small" style="margin:0"><b>First, try your phone's saved passwords</b> (iPhone: Settings → Passwords; Android: Google Password Manager).</p>
        <p class="small" style="margin:0">If that doesn't work, you can erase this app's data and start over, then restore your latest backup file from Settings.</p>
        <label class="field"><span>Type ERASE to confirm</span><input id="erase-confirm" autocapitalize="characters" autocomplete="off"></label>
        <button class="btn danger block" id="erase" disabled>Erase all data on this device</button>
        <button class="btn ghost block" id="back-login">Back to sign in</button>
      </div>`;
  } else {
    html = `${brand}
      <form class="card stack" id="auth-form" autocomplete="on">
        <h2 style="font-size:20px">Sign in</h2>
        <label class="field"><span>Username</span><input name="username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        ${showPw}
        <label class="row small" style="gap:8px"><input type="checkbox" name="remember" checked> Keep me signed in for ${REMEMBER_DAYS} days</label>
        <p class="status-text high small" id="auth-error" style="margin:0" hidden></p>
        <button class="btn primary block big" type="submit">Sign in</button>
        <button class="btn ghost block sm" type="button" id="forgot">Forgot password?</button>
      </form>`;
  }
  $('#app').innerHTML = `<div class="auth">${html}</div>`;

  $('#show-pw')?.addEventListener('change', (e) => {
    $$('#auth-form input[name=password], #auth-form input[name=confirm]').forEach((i) => { i.type = e.target.checked ? 'text' : 'password'; });
  });
  $('#forgot')?.addEventListener('click', () => viewAuth('forgot'));
  $('#back-login')?.addEventListener('click', () => viewAuth('login'));
  $('#erase-confirm')?.addEventListener('input', (e) => { $('#erase').disabled = e.target.value.trim() !== 'ERASE'; });
  $('#erase')?.addEventListener('click', async () => {
    try { sessionStorage.clear(); } catch { /* storage blocked */ }
    await destroyDatabase();
    location.hash = '#/today';
    location.reload();
  });

  $('#auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#auth-form button[type=submit]');
    const fd = new FormData(e.target);
    const username = fd.get('username').trim();
    const password = fd.get('password');
    btn.disabled = true;
    try {
      if (mode === 'setup') {
        if (!username) { toast('Enter a username'); return; }
        if (password.length < 6) { toast('Password must be at least 6 characters'); return; }
        if (password !== fd.get('confirm')) { toast('Passwords don\'t match'); return; }
        await saveAccount(username, password);
        await startSession(true);
      } else {
        const result = await verifyLogin(username, password);
        if (!result.ok) {
          const err = $('#auth-error');
          err.hidden = false;
          err.textContent = result.wait
            ? `Too many attempts. Try again in ${result.wait} seconds.`
            : 'Username or password is incorrect.';
          $('#auth-form [name=password]').value = '';
          return;
        }
        await startSession(fd.get('remember') === 'on');
      }
      unlocked = true;
      document.body.classList.remove('locked');
      router();
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function start() {
  await loadSettings();
  unlocked = !!(await getAccount()) && (await isSignedIn());
  window.addEventListener('hashchange', router);
  // Re-render Today when the app comes back to the foreground on a new day.
  let lastDay = todayISO();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayISO() !== lastDay) {
      lastDay = todayISO();
      if ((location.hash || '#/today').startsWith('#/today')) router();
    }
  });
  await router();
  // Ask the browser not to evict our data when storage runs low.
  try { await navigator.storage?.persist?.(); } catch { /* not supported */ }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  }
}

start();
