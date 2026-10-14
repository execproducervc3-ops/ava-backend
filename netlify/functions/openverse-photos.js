// Openverse photo finder for places: openly licensed images from many collections
// (Flickr and others). Wikimedia results are skipped here because the Commons finder
// already covers them. Only CC0, public domain, CC BY and CC BY-SA are kept; each image
// must name the place and mention SVG or its island. Proposals only.
// Optional: OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET raise the rate limit.
const { tokens } = require('./commons-photos');
const UA = process.env.WIKIMEDIA_USER_AGENT || 'AVA-PhotoFinder/1.0 (+https://askvincy.com; contact via site)';
const API = 'https://api.openverse.org/v1/images/';
const TOKEN_URL = 'https://api.openverse.org/v1/auth_tokens/token/';
const LICENCES = { 'cc0': 'CC0', 'pdm': 'Public domain', 'by': 'CC BY', 'by-sa': 'CC BY-SA' };
const GEO_RE = /vincent|grenadines|bequia|mustique|canouan|mayreau|union island|kingstown|svg\b/i;
const THUMB_HOST = /^(api\.openverse\.org|api\.openverse\.engineering)$/i;
const BAD_TITLE_RE = /\b(map|flag|coat of arms|logo|locator|stamp|banknote|diagram|poster|screenshot)\b/i;

let tokenCache = { value: null, until: 0 };
async function authHeader(fetchFn) {
  const id = process.env.OPENVERSE_CLIENT_ID, secret = process.env.OPENVERSE_CLIENT_SECRET;
  if (!id || !secret) return {};
  if (tokenCache.value && Date.now() < tokenCache.until) return { Authorization: `Bearer ${tokenCache.value}` };
  try {
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
    });
    if (!res.ok) return {};
    const d = await res.json();
    if (!d.access_token) return {};
    tokenCache = { value: d.access_token, until: Date.now() + Math.max(60, (d.expires_in || 600) - 60) * 1000 };
    return { Authorization: `Bearer ${tokenCache.value}` };
  } catch (e) { return {}; }
}

function evaluateResults(results, target) {
  const baseName = String(target.name || '').replace(/\(.*?\)/g, ' ');
  const need = tokens(baseName);
  const out = [];
  for (const r of results || []) {
    const lic = String(r.license || '').toLowerCase();
    if (!LICENCES[lic]) continue;
    if (/wiki/i.test(`${r.source || ''} ${r.provider || ''}`)) continue;
    const title = String(r.title || '');
    if (BAD_TITLE_RE.test(title)) continue;
    let thumb;
    try { thumb = new URL(r.thumbnail); } catch (e) { continue; }
    if (thumb.protocol !== 'https:' || !THUMB_HOST.test(thumb.hostname)) continue;
    if (!r.foreign_landing_url) continue;
    const tagText = (r.tags || []).map(t => t && t.name).filter(Boolean).join(' ');
    const hay = `${title} ${tagText}`;
    const hayLower = hay.toLowerCase();
    const matched = need.filter(t => hayLower.includes(t)).length;
    const coverage = need.length ? matched / need.length : 0;
    const geo = GEO_RE.test(hay) || (target.island ? hayLower.includes(String(target.island).toLowerCase()) : false);
    if (coverage < 0.6 || !geo) continue;
    const version = r.license_version ? ` ${r.license_version}` : '';
    const label = lic === 'cc0' || lic === 'pdm' ? LICENCES[lic] : `${LICENCES[lic]}${version}`;
    out.push({
      image_url: r.thumbnail,
      credit: `${String(r.creator || 'Unknown author').slice(0, 120)} / ${r.provider || r.source || 'Openverse'} via Openverse, ${label}`,
      license: label, license_url: r.license_url || null,
      source_url: r.foreign_landing_url,
      file_title: title.slice(0, 160) || null, width: r.width || null,
      score: Math.round(Math.min(0.8, coverage * 0.7 + 0.1) * 100) / 100,
      provider: 'openverse',
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

async function findCandidates(target, fetchFn, max = 3) {
  const q = target.queries && target.queries.length ? target.queries[0] : `${target.name} ${target.island || ''} Saint Vincent and the Grenadines`.replace(/\s+/g, ' ').trim();
  const params = new URLSearchParams({ q, license: 'cc0,pdm,by,by-sa', page_size: '20', mature: 'false' });
  const headers = Object.assign({ 'User-Agent': UA, 'Accept': 'application/json' }, await authHeader(fetchFn));
  const res = await fetchFn(`${API}?${params}`, { headers });
  if (!res.ok) throw new Error(`Openverse API ${res.status}`);
  const data = await res.json();
  return evaluateResults(data && data.results, target).slice(0, max);
}

module.exports = { findCandidates, evaluateResults, LICENCES };
