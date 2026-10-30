// A printable "Scan to see us on AVA" poster for one business: its name or logo, a QR code to its AVA page.
// Used by the poster web address and by the bot's /poster command.
const fs = require('fs');
const path = require('path');

const SITE = process.env.SITE_URL || 'https://askvincy.com';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function fontFiles() {
  const dirs = [path.join(__dirname, 'fonts'), process.env.LAMBDA_TASK_ROOT && path.join(process.env.LAMBDA_TASK_ROOT, 'netlify/functions/fonts'), process.env.LAMBDA_TASK_ROOT && path.join(process.env.LAMBDA_TASK_ROOT, 'fonts')].filter(Boolean);
  for (const d of dirs) {
    const f = ['Inter-Regular.ttf', 'Inter-Bold.ttf'].map(n => path.join(d, n));
    if (f.every(x => fs.existsSync(x))) return f;
  }
  return null;
}
function charW(c, bold) {
  if (' ijlI.,:;\'!|'.includes(c)) return bold ? 0.3 : 0.28;
  if ('ft'.includes(c)) return bold ? 0.4 : 0.37;
  if ('mwMW@'.includes(c)) return bold ? 0.92 : 0.86;
  if (/[A-Z0-9$]/.test(c)) return bold ? 0.68 : 0.64;
  return bold ? 0.58 : 0.54;
}
const textW = (t, size, bold) => [...t].reduce((a, c) => a + charW(c, bold), 0) * size;
function wrap(text, size, bold, maxW, maxLines) {
  const words = String(text).split(' ').filter(Boolean); const lines = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (textW(t, size, bold) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; } }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
  return lines;
}
function sniffImg(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf.length > 7 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length > 11 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
async function logoDataUri(url) {
  try {
    const u = new URL(String(url || '')), host = new URL(process.env.SUPABASE_URL).host;
    if (u.protocol !== 'https:' || u.host !== host) return null;
    const r = await fetch(u.toString()); if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const type = sniffImg(buf); if (!type || buf.length > 4000000) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch (e) { return null; }
}

// QR code as one SVG path (black squares), drawn from the library's module matrix.
function qrPath(text, x, y, size) {
  const QRCode = require('qrcode');
  const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = q.modules.size, cell = size / n, d = q.modules.data;
  let p = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!d[r * n + c]) { c++; continue; }
      let e = c; while (e < n && d[r * n + e]) e++;
      p += `M${(x + c * cell).toFixed(2)} ${(y + r * cell).toFixed(2)}h${((e - c) * cell).toFixed(2)}v${cell.toFixed(2)}h${(-(e - c) * cell).toFixed(2)}z`;
      c = e;
    }
  }
  return `<path d="${p}" fill="#000000"/>`;
}

function copyFor(info) {
  if (info.hasMenu) return { head: ['Scan to see', 'our menu'], sub: 'and place an order on AVA' };
  if (info.hasPrices) return { head: ['Scan to see', 'our prices'], sub: 'and find us on AVA' };
  return { head: ['Scan to find', 'us on AVA'], sub: 'prices, events and contact details' };
}

function posterSvg(info, size, mascot) {
  const A4 = size !== 'square';
  const W = A4 ? 1240 : 1080, H = A4 ? 1754 : 1080;
  const url = `${SITE}/l/${encodeURIComponent(info.id)}?src=qr`;
  const copy = copyFor(info);
  const TEAL = '#1B5E5E', INK = '#2B2116', GOLD = '#E8A317';
  const cx = W / 2;
  let svg = `<defs><clipPath id="lg"><circle cx="${A4 ? cx : 150}" cy="${A4 ? 215 : 150}" r="${A4 ? 120 : 90}"/></clipPath></defs><rect width="${W}" height="${H}" fill="#FBF7EE"/>
<rect x="0" y="0" width="${W / 3}" height="22" fill="#0072C6"/><rect x="${W / 3}" y="0" width="${W / 3}" height="22" fill="#FCD116"/><rect x="${2 * W / 3}" y="0" width="${W / 3}" height="22" fill="#009E60"/>
<rect x="0" y="${H - 22}" width="${W / 3}" height="22" fill="#0072C6"/><rect x="${W / 3}" y="${H - 22}" width="${W / 3}" height="22" fill="#FCD116"/><rect x="${2 * W / 3}" y="${H - 22}" width="${W / 3}" height="22" fill="#009E60"/>`;
  const mark = (mx, my, r) => info.logoDataUri
    ? `<circle cx="${mx}" cy="${my}" r="${r + 6}" fill="${GOLD}"/><circle cx="${mx}" cy="${my}" r="${r}" fill="#FFFFFF"/><image href="${info.logoDataUri}" x="${mx - r}" y="${my - r}" width="${2 * r}" height="${2 * r}" preserveAspectRatio="xMidYMid slice" clip-path="url(#lg)"/>`
    : `<g transform="translate(${mx - r * 0.73},${my - r}) scale(${(2 * r) / 440})"><g transform="translate(-180,-100)">${mascot}</g></g>`;

  if (A4) {
    svg += mark(cx, 215, 120);
    const nameLines = wrap(clean(info.name, 80), 78, true, W - 200, 2);
    svg += nameLines.map((l, i) => `<text x="${cx}" y="${430 + i * 90}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="78" fill="${TEAL}">${esc(l)}</text>`).join('');
    const hy = 430 + (nameLines.length - 1) * 90 + 130;
    svg += copy.head.map((l, i) => `<text x="${cx}" y="${hy + i * 108}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="100" fill="${INK}">${esc(l)}</text>`).join('');
    svg += `<text x="${cx}" y="${hy + 108 + 70}" text-anchor="middle" font-family="Inter" font-weight="400" font-size="40" fill="#786A57">${esc(copy.sub)}</text>`;
    const qy = hy + 108 + 110, qs = 520;
    svg += `<rect x="${cx - qs / 2 - 50}" y="${qy}" width="${qs + 100}" height="${qs + 100}" rx="44" fill="#FFFFFF" stroke="${TEAL}" stroke-width="10"/>${qrPath(url, cx - qs / 2, qy + 50, qs)}`;
    svg += `<text x="${cx}" y="${qy + qs + 100 + 80}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="58" fill="${TEAL}">askvincy.com</text>`;
    svg += `<text x="${cx}" y="${qy + qs + 100 + 128}" text-anchor="middle" font-family="Inter" font-weight="400" font-size="32" fill="#786A57">Point your phone camera at the code</text>`;
    svg += `<text x="${cx}" y="${H - 58}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="28" letter-spacing="2" fill="${GOLD}">AVA · ASK VINCY ANYTHING</text>`;
  } else {
    svg += mark(150, 150, 90);
    const nameLines = wrap(clean(info.name, 80), 54, true, W - 420, 2);
    svg += nameLines.map((l, i) => `<text x="270" y="${135 + i * 62}" font-family="Inter" font-weight="700" font-size="54" fill="${TEAL}">${esc(l)}</text>`).join('');
    svg += copy.head.map((l, i) => `<text x="70" y="${330 + i * 84}" font-family="Inter" font-weight="700" font-size="74" fill="${INK}">${esc(l)}</text>`).join('');
    svg += `<text x="70" y="${330 + 84 + 60}" font-family="Inter" font-weight="400" font-size="32" fill="#786A57">${esc(copy.sub)}</text>`;
    svg += `<text x="70" y="${H - 120}" font-family="Inter" font-weight="700" font-size="46" fill="${TEAL}">askvincy.com</text><text x="70" y="${H - 72}" font-family="Inter" font-weight="400" font-size="26" fill="#786A57">Point your phone camera at the code</text>`;
    const qs = 400;
    svg += `<rect x="${W - qs - 100 - 20}" y="${H - qs - 100 - 70}" width="${qs + 80}" height="${qs + 80}" rx="34" fill="#FFFFFF" stroke="${TEAL}" stroke-width="8"/>${qrPath(url, W - qs - 100 - 20 + 40, H - qs - 100 - 70 + 40, qs)}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svg}</svg>`;
}

// info: { id, name, logo_url, hasMenu, hasPrices }
async function renderPoster(info, size) {
  const fonts = fontFiles(); if (!fonts) throw new Error('poster fonts not found');
  const { Resvg } = require('@resvg/resvg-js');
  const mascot = require('./og-mascot');
  const withLogo = { ...info, logoDataUri: await logoDataUri(info.logo_url) };
  const svg = posterSvg(withLogo, size, mascot);
  return Buffer.from(new Resvg(svg, { font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng());
}

module.exports = { renderPoster, posterSvg };
