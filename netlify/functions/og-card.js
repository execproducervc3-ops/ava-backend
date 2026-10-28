// Builds the 1200x630 preview picture shown when an AVA link is posted to WhatsApp, Facebook etc.
// Deep teal card, tricolour edges, a picture or tile on the right, real headlines on the left.
const MASCOT = require('./og-mascot');

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };
function decodeEntities(s){
  let t = String(s ?? '');
  for(let i = 0; i < 2; i++){
    t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if(e[0] === '#'){
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      const v = NAMED[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }
  return t.replace(/[   ]/g, ' ');
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

// Rough Inter widths (in em) so lines can be wrapped without a text-measuring library.
function charW(c, bold){
  if(' ijlI.,:;\'!|'.includes(c)) return bold ? 0.3 : 0.28;
  if('ft'.includes(c)) return bold ? 0.4 : 0.37;
  if('mwMW@'.includes(c)) return bold ? 0.92 : 0.86;
  if(/[A-Z0-9]/.test(c)) return bold ? 0.68 : 0.64;
  return bold ? 0.58 : 0.54;
}
const textW = (t, size, bold) => [...t].reduce((a, c) => a + charW(c, bold), 0) * size;

function wrap(text, size, bold, maxW, maxLines){
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = []; let cur = '';
  const push = () => { if(cur){ lines.push(cur); cur = ''; } };
  for(let w of words){
    while(textW(w, size, bold) > maxW){
      let cut = w.length;
      while(cut > 1 && textW(w.slice(0, cut), size, bold) > maxW) cut--;
      push(); lines.push(w.slice(0, cut)); w = w.slice(cut);
    }
    const next = cur ? cur + ' ' + w : w;
    if(textW(next, size, bold) <= maxW) cur = next; else { push(); cur = w; }
  }
  push();
  if(lines.length > maxLines){
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while(last.length > 1 && textW(last + '…', size, bold) > maxW) last = last.slice(0, -1);
    kept[maxLines - 1] = last.replace(/[\s,.;:!-]+$/, '') + '…';
    return kept;
  }
  return lines;
}
const oneLine = (t, size, bold, maxW) => wrap(t, size, bold, maxW, 1)[0] || '';

const ACCENT = {
  news:    { fill: '#0072C6', ink: '#FFFFFF', label: 'NEWS' },
  price:   { fill: '#F0B840', ink: '#2B2116', label: 'PRICES' },
  listing: { fill: '#009E60', ink: '#FFFFFF', label: 'LOCAL BUSINESS' },
  answer:  { fill: '#FCD116', ink: '#2B2116', label: 'AVA ANSWER' },
};
const DOTS = ['#4DA3E8', '#F0B840', '#3DBE85'];

function stripe(y, h){
  return `<rect x="0" y="${y}" width="400" height="${h}" fill="#0072C6"/><rect x="400" y="${y}" width="400" height="${h}" fill="#FCD116"/><rect x="800" y="${y}" width="400" height="${h}" fill="#009E60"/>`;
}

function rightPanel(c, x, y, w, h){
  const type = c.type || 'answer';
  const cx = x + w / 2;
  // 1) A real photo (price listing or business), with a price badge when there is one.
  if(c.photo){
    const badge = '';
    return `
    <defs><clipPath id="pc"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26"/></clipPath></defs>
    <rect x="${x - 6}" y="${y - 6}" width="${w + 12}" height="${h + 12}" rx="32" fill="#F0B840"/>
    <image href="${c.photo}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#pc)"/>${badge}`;
  }
  // 2) News: a calendar tile with today's date.
  if(type === 'news' && c.dateTile){
    return `
    <rect x="${x + 10}" y="${y + 14}" width="${w}" height="${h}" rx="30" fill="#000000" fill-opacity="0.22"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="30" fill="#FBF7EE"/>
    <path d="M ${x} ${y + 30} Q ${x} ${y} ${x + 30} ${y} L ${x + w - 30} ${y} Q ${x + w} ${y} ${x + w} ${y + 30} L ${x + w} ${y + 96} L ${x} ${y + 96} Z" fill="#0072C6"/>
    <text x="${cx}" y="${y + 66}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="34" letter-spacing="4" fill="#FFFFFF">${esc(c.dateTile.mon)}</text>
    <text x="${cx}" y="${y + 262}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="170" fill="#2B2116">${esc(c.dateTile.day)}</text>
    <text x="${cx}" y="${y + 312}" text-anchor="middle" font-family="Inter" font-weight="400" font-size="26" fill="#786A57">${esc(c.dateTile.year || '')}</text>
    <rect x="${x + 34}" y="${y + h - 62}" width="${(w - 68) / 3}" height="8" rx="4" fill="#0072C6"/><rect x="${x + 34 + (w - 68) / 3}" y="${y + h - 62}" width="${(w - 68) / 3}" height="8" fill="#FCD116"/><rect x="${x + 34 + 2 * (w - 68) / 3}" y="${y + h - 62}" width="${(w - 68) / 3}" height="8" rx="4" fill="#009E60"/>
    <text x="${cx}" y="${y + h - 22}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="22" letter-spacing="2" fill="#1B5E5E">TODAY IN SVG</text>`;
  }
  // 4) Everything else: the parrot on a soft circle.
  const r = Math.min(w, h) / 2;
  return `
    <circle cx="${cx}" cy="${y + h / 2}" r="${r}" fill="#FFFFFF" fill-opacity="0.09"/>
    <circle cx="${cx}" cy="${y + h / 2}" r="${r - 26}" fill="#FFFFFF" fill-opacity="0.08"/>
    <svg x="${cx - 112}" y="${y + h / 2 - 154}" width="224" height="308" viewBox="180 100 320 440">${MASCOT}</svg>`;
}

function cardSvg(c){
  const W = 1200, H = 630, left = 64, type = ACCENT[c.type] ? c.type : 'answer', acc = ACCENT[type];
  const title0 = decodeEntities(c.title), body0 = decodeEntities(c.body);
  const items = (c.items || []).map(decodeEntities).filter(Boolean);
  const kicker = decodeEntities(c.kicker || acc.label).toUpperCase();
  const panelW = 380, panelH = 400, panelX = W - 56 - panelW, panelY = 150;
  const maxW = panelX - 40 - left;                      // text column beside the panel
  let tSize = type === 'news' ? 54 : 60, tLines = wrap(title0, tSize, true, maxW, 3);
  if(wrap(title0, tSize, true, maxW, 99).length > 3){ tSize = 46; tLines = wrap(title0, tSize, true, maxW, 3); }
  const tLH = tSize * 1.14, tStart = 222;
  const tEnd = tStart + (tLines.length - 1) * tLH;
  const startY = tEnd + 54, limit = 548;
  const tspans = (lines, x, lh) => lines.map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lh}">${esc(l)}</tspan>`).join('');

  let below = '';
  if(type === 'price' && c.price){
    const pSize = textW(c.price.amount, 120, true) > maxW ? 84 : 118, py = tEnd + 40 + pSize * 0.85;
    below = `<text x="${left}" y="${py}" font-family="Inter" font-weight="700" font-size="${pSize}" fill="#F0B840">${esc(c.price.amount)}</text>`
      + `<text x="${left}" y="${py + 60}" font-family="Inter" font-weight="700" font-size="30" fill="#FFFFFF">${esc(oneLine(decodeEntities(c.price.lead === 'FROM' ? 'Cheapest ' + c.price.note : c.price.note), 30, true, maxW))}</text>`
      + (body0 ? `<text x="${left}" y="${py + 102}" font-family="Inter" font-weight="400" font-size="26" fill="#BFD4CF">${esc(oneLine(body0, 26, false, maxW))}</text>` : '');
  } else if(items.length){
    const n = Math.max(0, Math.min(items.length, 3, Math.floor((limit - startY) / 46) + 1));
    below = items.slice(0, n).map((it, i) => {
      const y = startY + i * 46;
      return `<circle cx="${left + 8}" cy="${y - 9}" r="7" fill="${DOTS[i % 3]}"/><text x="${left + 30}" y="${y}" font-family="Inter" font-weight="400" font-size="26" fill="#D9E7E3">${esc(oneLine(it, 26, false, maxW - 30))}</text>`;
    }).join('');
    if(c.more > 0 && n >= items.length){
      const y = startY + n * 46;
      if(y <= limit + 4) below += `<text x="${left + 30}" y="${y}" font-family="Inter" font-weight="700" font-size="24" fill="#F0B840">+ ${c.more} more on AVA</text>`;
    }
  } else if(body0){
    const lines = wrap(body0, 29, false, maxW, Math.max(1, Math.min(3, Math.floor((limit - startY) / 40) + 1)));
    below = `<text x="${left}" y="${startY}" font-family="Inter" font-weight="400" font-size="29" fill="#D9E7E3">${tspans(lines, left, 40)}</text>`;
  }

  const chipW = Math.ceil(textW(kicker, 24, true) + kicker.length * 2.4) + 48;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0E3636"/><stop offset="1" stop-color="#1B5E5E"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <g fill="none" stroke="#FFFFFF" stroke-opacity="0.05" stroke-width="2">
    <circle cx="${W}" cy="${H}" r="260"/><circle cx="${W}" cy="${H}" r="340"/><circle cx="${W}" cy="${H}" r="420"/><circle cx="${W}" cy="${H}" r="500"/><circle cx="${W}" cy="${H}" r="580"/><circle cx="${W}" cy="${H}" r="660"/>
  </g>
  ${stripe(0, 14)}
  <rect x="${left - 10}" y="40" width="236" height="84" rx="42" fill="#FBF7EE"/>
  <svg x="${left + 8}" y="46" width="52" height="72" viewBox="180 100 320 440">${MASCOT}</svg>
  <text x="${left + 70}" y="102" font-family="Inter" font-weight="700" font-size="58"><tspan fill="#0072C6">A</tspan><tspan fill="#E5B80B">V</tspan><tspan fill="#009E60">A</tspan></text>
  <rect x="${W - 56 - chipW}" y="60" width="${chipW}" height="46" rx="23" fill="${acc.fill}"/>
  <text x="${W - 56 - chipW / 2}" y="92" text-anchor="middle" font-family="Inter" font-weight="700" font-size="24" letter-spacing="2" fill="${acc.ink}">${esc(kicker)}</text>
  <text x="${left}" y="${tStart}" font-family="Inter" font-weight="700" font-size="${tSize}" fill="#FFFFFF">${tspans(tLines, left, tLH)}</text>
  ${below}
  ${rightPanel({ ...c, type }, panelX, panelY, panelW, panelH)}
  <text x="${left}" y="${H - 38}" font-family="Inter" font-weight="700" font-size="28" fill="#F0B840">askvincy.com</text>
  <text x="${left + Math.round(textW('askvincy.com', 28, true)) + 18}" y="${H - 38}" font-family="Inter" font-weight="400" font-size="28" fill="#BFD4CF">\u00B7   Ask Vincy Anything</text>
  ${stripe(H - 14, 14)}
</svg>`;
}

module.exports = { cardSvg, wrap, textW, decodeEntities };
