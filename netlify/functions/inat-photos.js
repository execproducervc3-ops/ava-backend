// iNaturalist photo finder for wildlife species. Only observations that are research
// grade, wild (not captive), with a photo licensed CC0, CC BY or CC BY-SA. The licence is
// checked again on each photo, so a non-commercial photo is never proposed even if the
// API returned it. Proposals only: nothing shows in AVA until you approve it.
const UA = process.env.WIKIMEDIA_USER_AGENT || 'AVA-PhotoFinder/1.0 (+https://askvincy.com; contact via site)';
const API = 'https://api.inaturalist.org/v1/observations';
const LICENCES = { 'cc0': 'CC0', 'cc-by': 'CC BY', 'cc-by-sa': 'CC BY-SA' };
const PHOTO_HOSTS = /^(inaturalist-open-data\.s3\.amazonaws\.com|static\.inaturalist\.org)$/i;

function largeUrl(u) {
  return String(u || '').replace(/\/(square|small|medium|large|original)\.(\w+)(\?.*)?$/i, '/large.$2');
}

function evaluateObservations(results, target) {
  const out = [];
  const seenUsers = new Map();
  (results || []).forEach((obs, idx) => {
    if (!obs || obs.quality_grade !== 'research' || obs.captive) return;
    const user = obs.user || {};
    const who = (user.name || user.login || '').trim();
    for (const ph of obs.photos || []) {
      const code = String(ph.license_code || '').toLowerCase();
      if (!LICENCES[code]) continue;
      const url = largeUrl(ph.url);
      let host;
      try { host = new URL(url).hostname; } catch (e) { continue; }
      if (!PHOTO_HOSTS.test(host) || !/^https:/i.test(url)) continue;
      const dims = ph.original_dimensions;
      if (dims && dims.width && dims.width < 600) continue;
      const userKey = user.id || user.login || 'unknown';
      if ((seenUsers.get(userKey) || 0) >= 1) continue; // one per photographer, for variety
      seenUsers.set(userKey, 1);
      out.push({
        image_url: url,
        credit: `${who || 'Unknown author'} / iNaturalist, ${LICENCES[code]}`,
        license: LICENCES[code], license_url: null,
        source_url: ph.id ? `https://www.inaturalist.org/photos/${ph.id}` : (obs.uri || `https://www.inaturalist.org/observations/${obs.id}`),
        file_title: `iNaturalist photo ${ph.id || obs.id}${obs.taxon && obs.taxon.name ? ' (' + obs.taxon.name + ')' : ''}`,
        width: dims && dims.width || null,
        score: Math.round((0.8 - Math.min(idx, 20) * 0.01) * 100) / 100,
        provider: 'inaturalist',
      });
      break; // one photo per observation
    }
  });
  return out;
}

async function findCandidates(target, fetchFn, max = 3) {
  const sci = String(target.scientific || '').trim();
  if (!sci) return [];
  const params = new URLSearchParams({
    taxon_name: sci, photo_license: 'cc0,cc-by,cc-by-sa', quality_grade: 'research', captive: 'false',
    photos: 'true', order_by: 'votes', order: 'desc', per_page: '20', locale: 'en',
  });
  const res = await fetchFn(`${API}?${params}`, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`iNaturalist API ${res.status}`);
  const data = await res.json();
  return evaluateObservations(data && data.results, target).slice(0, max);
}

module.exports = { findCandidates, evaluateObservations, largeUrl, LICENCES };
