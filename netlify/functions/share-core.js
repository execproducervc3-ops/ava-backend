// Shared helpers for "share this answer" and "share this listing".
const crypto = require('crypto');

const SITE = process.env.SITE_URL || 'https://askvincy.com';

function shareKey(){
  const base = process.env.SHARE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return crypto.createHash('sha256').update('ava-share-v1:' + base).digest();
}
const signPayload = (str) => crypto.createHmac('sha256', shareKey()).update(String(str)).digest('hex');
function verifySig(str, sig){
  if(typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const good = Buffer.from(signPayload(str), 'hex'), given = Buffer.from(sig, 'hex');
  return good.length === given.length && crypto.timingSafeEqual(good, given);
}
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function shareId(sig){
  const bytes = crypto.createHash('sha256').update('id:' + sig).digest();
  let out = '';
  for(let i = 0; i < 10; i++) out += B62[bytes[i] % 62];
  return out;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const safeHttp = (u) => /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
function plainText(md, max){
  const t = String(md || '').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1').replace(/\*\*|__|_(?=\S)|`/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : t;
}
// JSON that is safe inside a <script> tag.
const scriptJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function renderPage(template, v){
  const map = {
    TITLE: esc(v.title), DESC: esc(v.desc), IMAGE: esc(v.image), URL: esc(v.url), ROBOTS: esc(v.robots),
    STATIC: v.staticHtml || '', DATA: scriptJson(v.data || {}), LD: v.ld ? `<script type="application/ld+json">${scriptJson(v.ld)}</script>` : '',
  };
  return template.replace(/\{\{([A-Z]+)\}\}/g, (m, k) => (k in map ? map[k] : m));
}

function answerTitle(q){
  const t = String(q || '').replace(/\s+/g, ' ').trim();
  if(!t) return 'An answer from AVA';
  const words = t.split(' ').length;
  let cap = t[0].toUpperCase() + t.slice(1);
  if(cap.length > 90) cap = cap.slice(0, 89).replace(/\s+\S*$/, '') + '…';
  if(words <= 3) return `What AVA says about "${t.slice(0, 60)}"`;
  return cap;
}


// What a shared answer is called: the preview title, the grey line under it, and the title on
// the picture. Never the bare question for short questions like "news" or "lettuce".
function answerPreview(d){
  d = d || {};
  const trim = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '\u2026' : s; };
  // 1. A price answer: "Lettuce from RB SALES, $5.00/lb, on AVA"
  const groups = Array.isArray(d.retailResults) ? d.retailResults.filter(g => g && Array.isArray(g.results) && g.results.length) : [];
  if (groups.length === 1) {
    const g = groups[0];
    const offers = g.results.filter(r => r && r.retailer && Number(r.price) > 0);
    if (offers.length) {
      const cheapest = offers.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
      const price = '$' + Number(cheapest.price).toFixed(2) + (cheapest.unit ? '/' + String(cheapest.unit).slice(0, 12) : '');
      const raw = trim(g.product || cheapest.item_name, 50);
      if (raw) {
        const product = raw[0].toUpperCase() + raw.slice(1);
        const vendors = new Set(offers.map(r => String(r.retailer).trim().toLowerCase())).size;
        return vendors === 1
          ? { title: `${product} from ${trim(cheapest.retailer, 60)}, ${price}, on AVA`, desc: 'Prices from vendors on AVA. Tap to see the vendor and send an enquiry.' }
          : { title: `${product} from ${price} at ${vendors} vendors, on AVA`, desc: 'Prices from vendors on AVA. Tap to compare and send an enquiry.' };
      }
    }
  }
  // 2. A news answer: "Latest news from SVG, 21 October 2026"
  const news = Array.isArray(d.newsResults) ? d.newsResults.filter(a => a && a.topic) : [];
  if (news.length) {
    const when = new Date(d.at || Date.now());
    const day = isNaN(when) ? '' : when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/St_Vincent' });
    return { title: `Latest news from Saint Vincent and the Grenadines${day ? ', ' + day : ''}, on AVA`, desc: trim(news.slice(0, 3).map(a => a.topic).join(' \u00b7 '), 200) };
  }
  // 3. A very short question ("ferry", "weather"): say what the answer is instead of echoing the question
  const q = String(d.q || '').replace(/\s+/g, ' ').trim();
  if (q && q.split(' ').length <= 3) {
    const first = plainText(d.text, 400).split(/(?<=[.!?])\s+/)[0];
    if (first && first.length >= 20) return { title: trim(first.replace(/[.!?:\-\u2013\u2014]+$/, ''), 90) + ' | AVA', desc: null };
  }
  return null;
}

module.exports = { answerPreview, answerTitle, SITE, signPayload, verifySig, shareId, esc, safeHttp, plainText, scriptJson, renderPage };
