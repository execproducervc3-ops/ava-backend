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

module.exports = { SITE, signPayload, verifySig, shareId, esc, safeHttp, plainText, scriptJson, renderPage };
