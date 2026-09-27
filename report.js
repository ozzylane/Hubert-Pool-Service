// Builds the customer-facing service report: a plain-text summary and a
// single JPEG "report card" (photo + readings + checklist) for texting/emailing.
import { readingsFor, readingStatus, fmtDay, fmtTime, loadImage } from './app.js';
import { db } from './db.js';

const firstName = (name) => (name || '').trim().split(/\s+/)[0] || 'there';

function doneItems(visit) {
  return Object.entries(visit.checklist || {}).filter(([, v]) => v).map(([k]) => k);
}
function readingList(visit, poolType) {
  return readingsFor(poolType).filter((r) => visit.readings?.[r.key] != null && visit.readings[r.key] !== '');
}

export function reportText(visit, client, settings) {
  const lines = [];
  const when = fmtDay(visit.day, { weekday: 'long', month: 'short', day: 'numeric' });
  lines.push(`Hi ${firstName(client.name)}, your pool was serviced on ${when}.`);
  const done = doneItems(visit);
  if (done.length) lines.push('', `✓ ${done.join('\n✓ ')}`);
  const readings = readingList(visit, client.poolType);
  if (readings.length) {
    lines.push('', 'Water test: ' + readings.map((r) => `${r.label} ${visit.readings[r.key]}${r.unit === '°F' ? '°F' : ''}`).join(', '));
  }
  if (visit.chemicals?.length) {
    lines.push('Added: ' + visit.chemicals.map((c) => `${c.name}${c.amount ? ` (${c.amount})` : ''}`).join(', '));
  }
  if (visit.notes) lines.push('', `Notes: ${visit.notes}`);
  const sign = [settings.techName, settings.businessName].filter(Boolean).join(', ');
  lines.push('', [settings.signoff, sign ? `— ${sign}` : '', settings.phone].filter(Boolean).join('\n'));
  return lines.join('\n');
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const font = (weight, size) => `${weight} ${size}px ${FONT}`;

function wrap(ctx, text, maxWidth, maxLines = 12) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  if (out.length > maxLines) {
    out.length = maxLines;
    out[maxLines - 1] += '…';
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const C = {
  brand: '#0b6fa4', brandDark: '#085a86', ink: '#10222e', muted: '#5d7282',
  tile: '#eef5fa', ok: '#1e8a4c', warn: '#b86b00', line: '#d9e4eb',
};

export async function buildReportCard(visit, client, settings) {
  const W = 1080;
  const P = 60;
  const inner = W - P * 2;

  const pick = visit.photos?.find((p) => p.kind === 'after') || visit.photos?.[0];
  let img = null;
  if (pick) {
    const rec = await db.get('photos', pick.id);
    if (rec) img = await loadImage(rec.blob);
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const done = doneItems(visit);
  const readings = readingList(visit, client.poolType);
  ctx.font = font(400, 34);
  const chemText = (visit.chemicals || []).map((c) => `${c.name}${c.amount ? ` – ${c.amount}` : ''}`).join('\n');
  const chemLines = chemText ? wrap(ctx, chemText, inner, 8) : [];
  const noteLines = visit.notes ? wrap(ctx, visit.notes, inner, 10) : [];

  // ---- measure ----
  const headerH = 190;
  const photoH = img ? Math.round(Math.min(W * 1.0, Math.max(W * 0.6, (img.naturalHeight / img.naturalWidth) * W))) : 0;
  const introH = 150;
  const SEC_TITLE = 64;
  const cols = 3;
  const tileH = 128;
  const gap = 16;
  const readH = readings.length ? SEC_TITLE + Math.ceil(readings.length / cols) * (tileH + gap) + 20 : 0;
  const checkRowH = 54;
  const checkH = done.length ? SEC_TITLE + Math.ceil(done.length / 2) * checkRowH + 24 : 0;
  const lineH = 46;
  const chemH = chemLines.length ? SEC_TITLE + chemLines.length * lineH + 24 : 0;
  const notesH = noteLines.length ? SEC_TITLE + noteLines.length * lineH + 24 : 0;
  const footerH = 150;
  const H = headerH + photoH + introH + readH + checkH + chemH + notesH + footerH;

  canvas.width = W;
  canvas.height = H;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  // ---- header ----
  const grad = ctx.createLinearGradient(0, 0, W, headerH);
  grad.addColorStop(0, C.brand);
  grad.addColorStop(1, C.brandDark);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, headerH);
  // soft wave
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  ctx.beginPath();
  ctx.moveTo(0, headerH - 40);
  for (let x = 0; x <= W; x += 20) ctx.lineTo(x, headerH - 40 + Math.sin(x / 70) * 14);
  ctx.lineTo(W, headerH); ctx.lineTo(0, headerH); ctx.closePath(); ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = font(800, 56);
  ctx.fillText(settings.businessName || 'Pool Service', P, 92, inner);
  ctx.font = font(500, 32);
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillText('Pool Service Report', P, 142);

  let y = headerH;

  // ---- photo (cover-fit) ----
  if (img) {
    const scale = Math.max(W / img.naturalWidth, photoH / img.naturalHeight);
    const sw = W / scale;
    const sh = photoH / scale;
    ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, y, W, photoH);
    y += photoH;
  }

  // ---- intro ----
  y += 70;
  ctx.fillStyle = C.ink;
  ctx.font = font(750, 44);
  ctx.fillText(client.name || '', P, y, inner);
  y += 50;
  ctx.fillStyle = C.muted;
  ctx.font = font(500, 30);
  ctx.fillText(`Serviced ${fmtDay(visit.day, { weekday: 'long', month: 'long', day: 'numeric' })} at ${fmtTime(visit.date)}`, P, y, inner);
  y += 30;

  const sectionTitle = (label) => {
    y += 52;
    ctx.fillStyle = C.brand;
    ctx.font = font(800, 25);
    ctx.fillText(label.toUpperCase(), P, y);
    y += 12;
  };

  // ---- readings ----
  if (readings.length) {
    sectionTitle('Water test');
    const tileW = (inner - gap * (cols - 1)) / cols;
    readings.forEach((r, i) => {
      const cx = P + (i % cols) * (tileW + gap);
      const cy = y + Math.floor(i / cols) * (tileH + gap);
      ctx.fillStyle = C.tile;
      roundRect(ctx, cx, cy, tileW, tileH, 18);
      ctx.fill();
      ctx.fillStyle = C.muted;
      ctx.font = font(600, 24);
      ctx.fillText(r.label, cx + 20, cy + 40, tileW - 50);
      const st = readingStatus(r, visit.readings[r.key], client.poolType);
      if (st) {
        ctx.fillStyle = st === 'ok' ? C.ok : C.warn;
        ctx.beginPath();
        ctx.arc(cx + tileW - 24, cy + 32, 9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = C.ink;
      ctx.font = font(800, 46);
      const val = String(visit.readings[r.key]);
      ctx.fillText(val, cx + 20, cy + 98, tileW - 40);
      if (r.unit) {
        const vw = ctx.measureText(val).width;
        ctx.fillStyle = C.muted;
        ctx.font = font(500, 24);
        ctx.fillText(r.unit, cx + 20 + vw + 8, cy + 98);
      }
    });
    y += Math.ceil(readings.length / cols) * (tileH + gap) + 8;
  }

  // ---- checklist ----
  if (done.length) {
    sectionTitle('Completed');
    const colW = inner / 2;
    done.forEach((item, i) => {
      const cx = P + (i % 2) * colW;
      const cy = y + Math.floor(i / 2) * checkRowH + 40;
      ctx.fillStyle = C.ok;
      ctx.beginPath();
      ctx.arc(cx + 15, cy - 11, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + 8, cy - 11); ctx.lineTo(cx + 13, cy - 5); ctx.lineTo(cx + 23, cy - 17);
      ctx.stroke();
      ctx.fillStyle = C.ink;
      ctx.font = font(500, 30);
      ctx.fillText(item, cx + 44, cy, colW - 56);
    });
    y += Math.ceil(done.length / 2) * checkRowH + 12;
  }

  const textBlock = (title, lines) => {
    sectionTitle(title);
    ctx.fillStyle = C.ink;
    ctx.font = font(400, 34);
    lines.forEach((l, i) => ctx.fillText(l, P, y + 40 + i * lineH, inner));
    y += lines.length * lineH + 12;
  };
  if (chemLines.length) textBlock('Chemicals added', chemLines);
  if (noteLines.length) textBlock('Notes', noteLines);

  // ---- footer ----
  const fy = H - footerH;
  ctx.fillStyle = C.line;
  ctx.fillRect(P, fy + 20, inner, 2);
  ctx.fillStyle = C.ink;
  ctx.font = font(700, 30);
  ctx.fillText(settings.signoff || 'Thank you!', P, fy + 76, inner);
  ctx.fillStyle = C.muted;
  ctx.font = font(500, 26);
  ctx.fillText([settings.techName, settings.businessName, settings.phone].filter(Boolean).join('  ·  '), P, fy + 116, inner);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image export failed'))), 'image/jpeg', 0.88));
}

