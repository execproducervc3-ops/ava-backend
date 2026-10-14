// Finds freely licensed photos on Wikimedia Commons for a place or species.
// Only PROPOSES candidates. A photo reaches AVA only after the admin approves it.
// Safety rules (all enforced here, not left to the caller):
//  - licence must be CC0, public domain, CC BY or CC BY-SA (no NC/ND, no GFDL-only, no fair use)
//  - the file title/description/categories must mention the place's own distinctive words
//  - for places, it must also mention Saint Vincent / the Grenadines / the island, so a
//    "Fort Hamilton" in Bermuda is never proposed
//  - image at least 800px wide, a photo format (not SVG, not PDF)

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = process.env.WIKIMEDIA_USER_AGENT || 'AskVincyBot/1.0 (https://askvincy.com; place photos with attribution)';

const GENERIC = new Set(['the', 'of', 'and', 'in', 'on', 'park', 'beach', 'bay', 'island', 'heritage', 'recreational', 'centre', 'center', 'nature', 'museum', 'st', 'saint']);
const GEO_RE = /vincent|grenadines|bequia|mustique|canouan|mayreau|union island|kingstown|svg\b/i;
const SPECIES_BAD_RE = /\b(skull|skeleton|specimen|taxiderm\w*|museum|illustration|drawing|painting|engraving|plate|distribution|range|cladogram|egg|eggs|dead|carcass|stuffed|fossil|tattoo|toy|statue)\b/i;
const BAD_TITLE_RE = /\b(map|flag|coat of arms|logo|locator|stamp|banknote|diagram|poster|screenshot)\b/i;

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function licenceAllowed(short) {
  const s = String(short || '').trim();
  if (!s) return false;
  if (/\b(nc|nd)\b/i.test(s) || /non-?commercial|noderiv/i.test(s)) return false;
  return /^cc0\b/i.test(s) || /^public domain\b/i.test(s) || /^pd[-\s]/i.test(s) || /^cc[- ]by(-sa)?[- ]\d/i.test(s);
}

function tokens(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !GENERIC.has(t));
}

function nameParts(name) {
  const paren = [...String(name).matchAll(/\(([^)]+)\)/g)].map(m => m[1].trim());
  const base = String(name).replace(/\([^)]*\)/g, ' ').replace(/,.*$/, '').replace(/\s+/g, ' ').trim();
  return { base, paren };
}

function queryVariants(name, island) {
  const { base, paren } = nameParts(name);
  const isl = island && island !== 'Saint Vincent' ? island : 'Saint Vincent';
  const out = [`${base} ${isl}`];
  for (const p of paren) out.push(`${p.replace(/^also\s+/i, '')} ${isl}`);
  out.push(`${base} Saint Vincent and the Grenadines`);
  return [...new Set(out.map(q => q.replace(/\s+/g, ' ').trim()))].slice(0, 3);
}

// Pick up to `max` acceptable candidates from raw Commons API pages.
function evaluatePages(pages, target) {
  const wantTokens = target.mustMatch ? [] : [...new Set([...tokens(nameParts(target.name).base), ...nameParts(target.name).paren.flatMap(tokens)])];
  const baseTokens = tokens(nameParts(target.name).base);
  const out = [];
  for (const p of pages || []) {
    const ii = p.imageinfo && p.imageinfo[0];
    if (!ii) continue;
    const meta = ii.extmetadata || {};
    const val = k => stripHtml(meta[k] && meta[k].value);
    const title = String(p.title || '').replace(/^File:/i, '');
    if (!/^image\/(jpeg|png|webp)$/i.test(ii.mime || '')) continue;
    if ((ii.width || 0) < 800) continue;
    if (BAD_TITLE_RE.test(title)) continue;
    if (target.mustMatch && SPECIES_BAD_RE.test(title)) continue;
    if (val('NonFree').toLowerCase() === 'true') continue;
    const licence = val('LicenseShortName');
    if (!licenceAllowed(licence)) continue;
    const hay = `${title} ${val('ImageDescription')} ${val('ObjectName')} ${val('Categories')}`;
    let coverage, geo;
    if (target.mustMatch) {
      if (!target.mustMatch.test(hay)) continue;
      coverage = 1; geo = true;
    } else {
      const hayTokens = new Set(tokens(hay));
      const need = baseTokens.length ? baseTokens : wantTokens;
      if (!need.length) continue;
      const matched = need.filter(t => hayTokens.has(t) || hay.toLowerCase().includes(t)).length;
      coverage = matched / need.length;
      geo = GEO_RE.test(hay) || (target.island ? hay.toLowerCase().includes(String(target.island).toLowerCase()) : false);
      if (coverage < 0.6 || !geo) continue;
    }
    const artist = val('Artist') || val('Credit') || 'Unknown author';
    const credit = `${artist.slice(0, 120)} / Wikimedia Commons, ${licence}`;
    out.push({
      image_url: ii.thumburl || ii.url,
      credit, license: licence, license_url: meta.LicenseUrl && meta.LicenseUrl.value || null,
      source_url: ii.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title || '')}`,
      file_title: title, width: ii.thumbwidth || ii.width || null,
      score: Math.round(Math.min(1, coverage * 0.85 + (geo ? 0.15 : 0)) * 100) / 100,
      _rank: p.index || 99,
    });
  }
  out.sort((a, b) => b.score - a.score || a._rank - b._rank);
  return out.map(({ _rank, ...rest }) => rest);
}

async function searchCommons(query, fetchFn) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: query, gsrnamespace: '6', gsrlimit: '10',
    prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '900', iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|Credit|ImageDescription|ObjectName|Categories|NonFree|Restrictions',
  });
  const res = await fetchFn(`${API}?${params}`, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Commons API ${res.status}`);
  const data = await res.json();
  const pages = data && data.query && data.query.pages ? Object.values(data.query.pages) : [];
  return pages;
}

// target: { name, island, queries?, mustMatch? }
async function findCandidates(target, fetchFn, max = 3) {
  const queries = target.queries && target.queries.length ? target.queries : queryVariants(target.name, target.island);
  const seen = new Map();
  for (const q of queries) {
    let pages;
    try { pages = await searchCommons(q, fetchFn); } catch (e) { if (seen.size) break; throw e; }
    for (const c of evaluatePages(pages, target)) if (!seen.has(c.image_url)) seen.set(c.image_url, c);
    if (seen.size >= max) break;
  }
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, max);
}

module.exports = { findCandidates, evaluatePages, queryVariants, licenceAllowed, stripHtml, tokens };
