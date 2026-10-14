// OpenStreetMap landmark import helpers. Data (c) OpenStreetMap contributors, ODbL.
// Pure functions + one fetch wrapper, so they can be tested without a network.

const ISLAND_BOXES = {
  'Saint Vincent':       { s: 13.12, w: -61.30, n: 13.40, e: -61.09 },
  'Bequia':              { s: 12.96, w: -61.29, n: 13.05, e: -61.19 },
  'Mustique':            { s: 12.85, w: -61.21, n: 12.90, e: -61.15 },
  'Canouan':             { s: 12.68, w: -61.37, n: 12.74, e: -61.30 },
  'Mayreau':             { s: 12.62, w: -61.42, n: 12.66, e: -61.37 },
  'Union Island':        { s: 12.57, w: -61.48, n: 12.62, e: -61.42 },
  'Palm Island':         { s: 12.565, w: -61.405, n: 12.59, e: -61.375 },
  'Petit Saint Vincent': { s: 12.515, w: -61.40, n: 12.545, e: -61.365 },
};
const IMPORT_ISLANDS = Object.keys(ISLAND_BOXES);

// Each group is one Overpass request, so a request stays small and quick.
const GROUPS = {
  money_fuel: [['amenity', 'bank'], ['amenity', 'fuel'], ['amenity', 'post_office']],
  schools_health: [['amenity', 'school'], ['amenity', 'pharmacy'], ['amenity', 'clinic'], ['amenity', 'hospital'], ['amenity', 'police']],
  churches: [['amenity', 'place_of_worship']],
  shops: [['shop', 'supermarket'], ['shop', 'convenience'], ['amenity', 'marketplace']],
  food_stay: [['amenity', 'restaurant'], ['amenity', 'bar'], ['amenity', 'pub'], ['tourism', 'hotel'], ['tourism', 'guest_house']],
  roads: [['man_made', 'bridge'], ['junction', 'roundabout']],
};
const GROUP_NAMES = Object.keys(GROUPS);

// Big islands are asked for in horizontal bands so each request stays small.
const TILES = { 'Saint Vincent': 4, 'Bequia': 1 };
const tileCount = (island) => TILES[island] || 1;

function buildQuery(island, group, tile){
  const full = ISLAND_BOXES[island];
  const n = tileCount(island), t = Math.min(Math.max(Number(tile) || 0, 0), n - 1);
  const b = full && n > 1 ? { s: full.s + (full.n - full.s) * t / n, n: full.s + (full.n - full.s) * (t + 1) / n, w: full.w, e: full.e } : full;
  const list = GROUPS[group];
  if(!b || !list) throw new Error('Unknown island or group');
  const r6 = (x) => Number(x.toFixed(5));
  const box = `${r6(b.s)},${r6(b.w)},${r6(b.n)},${r6(b.e)}`;
  const lines = list.map(([k, v]) => `nwr["${k}"="${v}"]["name"](${box});`).join('\n');
  return `[out:json][timeout:20];\n(\n${lines}\n);\nout center tags 400;`;
}

function classify(tags){
  tags = tags || {};
  if(tags.amenity === 'bank') return 'bank';
  if(tags.amenity === 'place_of_worship') return 'church';
  if(tags.amenity === 'fuel') return 'gas_station';
  if(tags.amenity === 'school') return 'school';
  if(tags.shop === 'supermarket') return 'supermarket';
  if(tags.shop === 'convenience') return 'shop';
  if(tags.amenity === 'restaurant') return 'restaurant';
  if(tags.amenity === 'bar' || tags.amenity === 'pub') return 'bar';
  if(tags.amenity === 'pharmacy') return 'pharmacy';
  if(tags.amenity === 'police') return 'police';
  if(tags.amenity === 'clinic') return 'clinic';
  if(tags.amenity === 'hospital') return 'hospital';
  if(tags.amenity === 'marketplace') return 'market';
  if(tags.amenity === 'post_office') return 'post_office';
  if(tags.tourism === 'hotel' || tags.tourism === 'guest_house') return 'hotel';
  if(tags.man_made === 'bridge') return 'bridge';
  if(tags.junction === 'roundabout') return 'roundabout';
  return null;
}

// Turns an Overpass reply into candidate rows. Drops anything without a name,
// a recognised kind, coordinates inside the island box, or a repeated name.
function parseElements(data, island){
  const b = ISLAND_BOXES[island];
  const out = [], seen = new Set();
  for(const el of (data && data.elements) || []){
    const tags = el.tags || {};
    const name = String(tags.name || '').trim();
    const kind = classify(tags);
    const lat = el.lat != null ? el.lat : el.center && el.center.lat;
    const lng = el.lon != null ? el.lon : el.center && el.center.lon;
    if(!name || name.length > 120 || !kind || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if(!b || lat < b.s || lat > b.n || lng < b.w || lng > b.e) continue;
    const key = name.toLowerCase();
    if(seen.has(key)) continue;
    seen.add(key);
    out.push({ osm_ref: `${el.type}/${el.id}`, name, kind, island, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) });
  }
  return out;
}

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function fetchOverpass(query, fetchImpl){
  const f = fetchImpl || fetch;
  const errs = [];
  for(const url of OVERPASS){
    try{
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 7000);
      const res = await f(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'AskVincy-AVA/1.0 (askvincy.com)' },
        body: 'data=' + encodeURIComponent(query),
      });
      clearTimeout(t);
      if(!res.ok) throw new Error('OpenStreetMap server replied ' + res.status);
      return await res.json();
    } catch(e){ errs.push(new URL(url).hostname + ': ' + (e.name === 'AbortError' ? 'no answer in 7s' : e.message)); }
  }
  throw new Error('Could not reach OpenStreetMap right now (' + errs.join('; ') + '). Try again in a minute.');
}

const osmUrl = (ref) => `https://www.openstreetmap.org/${ref}`;

module.exports = { tileCount, OVERPASS, ISLAND_BOXES, IMPORT_ISLANDS, GROUPS, GROUP_NAMES, buildQuery, classify, parseElements, fetchOverpass, osmUrl };
