// Builds the 1200x630 preview picture shown when a shared link is posted to WhatsApp, Facebook etc.
const MASCOT = require('./og-mascot');

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
    while(textW(w, size, bold) > maxW){            // very long word: hard-break
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

function cardSvg({ kicker, title, body, footer }){
  const W = 1200, H = 630, left = 70, maxW = 1060;
  // Shrink the title for long text so it still fits in 3 lines.
  let tSize = 68, tLines = wrap(title, tSize, true, maxW, 3);
  if(wrap(title, tSize, true, maxW, 99).length > 3){ tSize = 52; tLines = wrap(title, tSize, true, maxW, 3); }
  const bLines = body ? wrap(body, 30, false, maxW, tLines.length >= 3 ? 2 : 3) : [];
  void 0;
  const tStart = tLines.length >= 3 ? 250 : 270, tLH = tSize * 1.15;
  const bStart = tStart + (tLines.length - 1) * tLH + 66;
  const tspans = (lines, x, lh) => lines.map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lh}">${esc(l)}</tspan>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#FBF7EE"/>
  <rect x="0" y="0" width="400" height="16" fill="#0072C6"/><rect x="400" y="0" width="400" height="16" fill="#FCD116"/><rect x="800" y="0" width="400" height="16" fill="#009E60"/>
  <svg x="${left}" y="48" width="86" height="118" viewBox="180 100 320 440">${MASCOT}</svg>
  <text x="${left + 104}" y="132" font-family="Inter" font-weight="700" font-size="72"><tspan fill="#0072C6">A</tspan><tspan fill="#E5B80B">V</tspan><tspan fill="#009E60">A</tspan></text>
  <text x="${W - left}" y="120" text-anchor="end" font-family="Inter" font-weight="700" font-size="26" letter-spacing="2" fill="#786A57">${esc(String(kicker || '').toUpperCase())}</text>
  <text x="${left}" y="${tStart}" font-family="Inter" font-weight="700" font-size="${tSize}" fill="#2B2116">${tspans(tLines, left, tLH)}</text>
  ${bLines.length ? `<text x="${left}" y="${bStart}" font-family="Inter" font-weight="400" font-size="30" fill="#786A57">${tspans(bLines, left, 42)}</text>` : ''}
  <text x="${left}" y="${H - 48}" font-family="Inter" font-weight="700" font-size="28" fill="#1B5E5E">${esc(footer || 'askvincy.com  ·  Ask Vincy Anything')}</text>
  <rect x="0" y="${H - 14}" width="400" height="14" fill="#0072C6"/><rect x="400" y="${H - 14}" width="400" height="14" fill="#FCD116"/><rect x="800" y="${H - 14}" width="400" height="14" fill="#009E60"/>
</svg>`;
}

module.exports = { cardSvg, wrap, textW };
