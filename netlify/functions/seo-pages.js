// Public, Google-readable pages built from AVA's live data:
//   /food/<dish>  /fares/taxi  /fares/bus  /ferry  /prices  /prices/<product>  /directory  /directory/<category>  /sitemap.xml
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SITE = process.env.SITE_URL || 'https://askvincy.com';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const slugify = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const money = (n) => (n == null || n === '' || isNaN(Number(n))) ? '' : 'EC$' + Number(n).toFixed(2).replace(/\.00$/, '');
const ldJson = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const CATEGORIES = {
  restaurants: { db: 'restaurant', title: 'Restaurants' }, pharmacies: { db: 'pharmacy', title: 'Pharmacies' },
  doctors: { db: 'doctor', title: 'Doctors' }, 'taxi-services': { db: 'taxi_service', title: 'Taxi services' },
  'car-rentals': { db: 'car_rental', title: 'Car rentals' }, accommodation: { db: 'accommodation', title: 'Places to stay' },
  nightlife: { db: 'nightlife', title: 'Nightlife' }, cinemas: { db: 'cinema', title: 'Cinemas' }, retailers: { db: 'retailer', title: 'Shops and retailers' },
};

function shell({ title, desc, path, body, ld, noindex }) {
  const url = SITE + path;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(url)}">
<meta name="robots" content="${noindex ? 'noindex, follow' : 'index, follow'}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${SITE}/og-default.png">
<style>:root{--teal:#1B5E5E;--ink:#2B2116;--soft:#786A57;--bg:#FBF7EE;--card:#fff;--line:#E7DFCF;--gold:#E8A317}
@media(prefers-color-scheme:dark){:root{--ink:#F2EBDD;--soft:#B9AC96;--bg:#16201F;--card:#1E2B2A;--line:#33423F;--teal:#7FD1C4}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{background:#1B5E5E;color:#fff;padding:12px 16px}header a{color:#fff;text-decoration:none;font-weight:700}
main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:26px;line-height:1.2;margin:8px 0 6px}h2{font-size:18px;margin:22px 0 8px}
.lead{color:var(--soft);margin:0 0 14px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 0}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line)}th{color:var(--soft);font-weight:600}
a{color:var(--teal)}.cta{display:inline-block;background:#1B5E5E;color:#fff!important;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:700;margin:14px 0}
.note{font-size:13px;color:var(--soft)}.tag{background:var(--gold);color:#2B2116;border-radius:6px;padding:1px 6px;font-size:12px;font-weight:700}
nav.links a{margin-right:12px;white-space:nowrap}</style>${ld ? ldJson(ld) : ''}</head><body>
<header><a href="/">AVA &middot; Ask Vincy Anything</a></header><main>${body}
<p><a class="cta" href="/">Ask AVA anything about Saint Vincent</a></p>
<nav class="links note"><a href="/food">Food</a><a href="/prices">Prices</a><a href="/fares/taxi">Taxi fares</a><a href="/fares/bus">Bus fares</a><a href="/ferry">Ferries</a><a href="/directory">Directory</a></nav>
<p class="note">Information is gathered by AVA and can change. Please confirm before you travel or buy.</p></main></body></html>`;
}
const page = (code, html, ttl) => ({ statusCode: code, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': code === 200 ? `public, max-age=300, s-maxage=${ttl || 900}, stale-while-revalidate=3600` : 'public, max-age=60' }, body: html });
const notFound = () => page(404, shell({ title: 'Page not found | AVA', desc: 'Page not found', path: '/', noindex: true, body: '<h1>We could not find that page</h1><p class="lead">Try asking AVA instead.</p>' }));
const daysAgo = (d) => { const n = Math.floor((Date.now() - new Date(d).getTime()) / 86400000); return n <= 0 ? 'today' : n === 1 ? 'yesterday' : n + ' days ago'; };

// ---------- menu dishes ----------
const stem = (w) => w.length > 3 ? w.replace(/(es|s)$/, '') : w;
const toks = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !['and', 'the', 'with', 'of', 'a', 'an'].includes(w)).map(stem);
async function menuListings() {
  const { data, error } = await supabase.from('directory_listings').select('id, name, address, island, phone, menu_items, menu_updated_at, subscribed_until').eq('status', 'active').not('menu_items', 'is', null).limit(1000);
  if (error) throw error;
  return (data || []).filter(l => !l.subscribed_until || new Date(l.subscribed_until) > new Date());
}
const forItems = (l, fn) => { for (const s of (Array.isArray(l.menu_items) ? l.menu_items : [])) for (const i of (s && Array.isArray(s.items) ? s.items : [])) fn(i, s); };
function dishIndex(listings) {  // slug -> {name, count}
  const m = new Map();
  for (const l of listings) { const seen = new Set(); forItems(l, (i) => { const n = String(i.name || '').trim(); const sl = slugify(n); if (!n || n.length > 50 || !sl || seen.has(sl)) return; seen.add(sl); const e = m.get(sl) || { name: n, count: 0 }; e.count++; m.set(sl, e); }); }
  return m;
}
async function foodIndex() {
  const idx = dishIndex(await menuListings());
  const list = [...idx.entries()].sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name)).slice(0, 300);
  const body = `<h1>Food and drink on Saint Vincent menus</h1><p class="lead">Dishes from restaurant menus on AVA. Tap a dish to see who serves it and the price.</p>` +
    (list.length ? `<div class="card">${list.map(([sl, e]) => `<a href="/food/${esc(sl)}" style="display:inline-block;margin:4px 10px 4px 0">${esc(e.name)}</a>`).join('')}</div>` : '<p>No menus on AVA yet.</p>');
  return page(200, shell({ title: 'Food and drink menus in Saint Vincent | AVA', desc: 'Dishes and prices from restaurant menus in Saint Vincent and the Grenadines, found on AVA.', path: '/food', body }));
}
async function foodPage(slug) {
  const listings = await menuListings();
  const qt = toks(slug.replace(/-/g, ' ')); if (!qt.length) return notFound();
  const results = [];
  for (const l of listings) {
    const hits = []; forItems(l, (i) => { const t = toks(`${i.name || ''} ${i.note || ''}`); if (qt.every(w => t.includes(w))) hits.push(i); });
    if (hits.length) results.push({ l, hits: hits.slice(0, 4) });
  }
  if (!results.length) return notFound();
  results.sort((a, b) => String(b.l.menu_updated_at || '').localeCompare(String(a.l.menu_updated_at || '')));
  let dish = (dishIndex(listings).get(slug) || {}).name || slug.replace(/-/g, ' '); dish = dish.charAt(0).toUpperCase() + dish.slice(1);
  const priceTxt = (p) => !p ? '' : /^[\d.]+$/.test(String(p).trim()) ? 'EC$' + String(p).trim() : String(p);
  const body = `<h1>Where to get ${esc(dish)} in Saint Vincent</h1><p class="lead">${results.length} restaurant${results.length > 1 ? 's' : ''} on AVA list${results.length > 1 ? '' : 's'} this on their current menu.</p>` +
    results.map(({ l, hits }) => `<div class="card"><b><a href="/l/${esc(l.id)}">${esc(l.name)}</a></b>${l.island ? ` <span class="note">${esc(l.island)}</span>` : ''}${l.address ? `<div class="note">${esc(l.address)}</div>` : ''}${hits.map(i => `<div class="row"><span>${esc(i.name)}</span><b>${esc(priceTxt(i.price))}</b></div>`).join('')}${l.menu_updated_at ? `<div class="note">Menu updated ${esc(daysAgo(l.menu_updated_at))}</div>` : ''}<a href="/l/${esc(l.id)}">See the full menu and place an order</a></div>`).join('');
  const ld = { '@context': 'https://schema.org', '@type': 'ItemList', name: `Where to get ${dish} in Saint Vincent`, itemListElement: results.map((r, n) => ({ '@type': 'ListItem', position: n + 1, url: `${SITE}/l/${r.l.id}`, name: r.l.name })) };
  return page(200, shell({ title: `${dish} in Saint Vincent: where to get it and prices | AVA`, desc: `${results.length} restaurant${results.length > 1 ? 's' : ''} in Saint Vincent and the Grenadines serving ${dish}, with prices from their menus on AVA.`, path: `/food/${slug}`, body, ld }));
}

// ---------- fares ----------
function cruiseHtml(rows, h) {
  if (!rows.length) return '';
  const label = (t) => String(t || '').replace(/(\d)_(\d)/g, '$1-$2').replace(/_/g, ' ').replace(/\bover\b/i, 'Over').replace(/^./, c => c.toUpperCase());
  const byPlace = new Map();
  for (const r of rows) { const k = (r.places || []).join(', '); if (!byPlace.has(k)) byPlace.set(k, []); byPlace.get(k).push(r); }
  const isReturn = (t) => /return|round/i.test(String(t || ''));
  const body = [...byPlace.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([place, rs]) => {
    const tiers = [...new Set(rs.map(r => r.passenger_tier))];
    return `<tr><th colspan="4" style="padding-top:12px">${esc(place)}</th></tr>` + tiers.map(t => {
      const one = rs.find(r => r.passenger_tier === t && !isReturn(r.trip_type)), ret = rs.find(r => r.passenger_tier === t && isReturn(r.trip_type));
      return `<tr><td>${esc(label(t))} passengers</td><td>${one ? esc(money(one.regular_fare)) : ''}</td><td>${one ? esc(money(one.after_hours_fare)) : ''}</td><td>${ret ? esc(money(ret.regular_fare)) : ''}</td></tr>`;
    }).join('');
  }).join('');
  return `<h2>${esc(h)}</h2><p class="note">Fares depend on group size. Return fares are for the round trip; no after-hours rate is published for return trips.</p><div class="card"><table><tr><th>Group</th><th>One way</th><th>After hours</th><th>Return</th></tr>${body}</table></div>`;
}
async function taxiPage() {
  const { data, error } = await supabase.from('taxi_fares_official').select('places, regular_fare, after_hours_fare, origin_type, passenger_tier, trip_type, additional_passenger_fee');
  if (error) throw error; if (!data || !data.length) return notFound();
  const groups = { airport: ['From Argyle International Airport (AIA)', 'The fare is for the taxi, for 1 to 3 passengers; each extra passenger adds the fee shown.'], kingstown: ['From Kingstown', 'Fares are per passenger.'], cruise_ship_berth: ['From the cruise ship berth', ''] };
  const body = `<h1>Official taxi fares in Saint Vincent</h1><p class="lead">Official fares for popular trips. After-hours fares apply late at night.</p>` +
    Object.entries(groups).map(([k, [h, n]]) => { if (k === 'cruise_ship_berth') return cruiseHtml(data.filter(r => r.origin_type === k), h); const rows = data.filter(r => r.origin_type === k); if (!rows.length) return ''; return `<h2>${esc(h)}</h2>${n ? `<p class="note">${esc(n)}</p>` : ''}<div class="card"><table><tr><th>To</th><th>Fare</th><th>After hours</th>${k === 'airport' ? '<th>Extra passenger</th>' : ''}</tr>${rows.sort((a, b) => String(a.places[0]).localeCompare(String(b.places[0]))).map(r => `<tr><td>${esc((r.places || []).join(', '))}</td><td>${esc(money(r.regular_fare))}</td><td>${esc(money(r.after_hours_fare))}</td>${k === 'airport' ? `<td>${esc(money(r.additional_passenger_fee))}</td>` : ''}</tr>`).join('')}</table></div>`; }).join('');
  return page(200, shell({ title: 'Taxi fares in Saint Vincent: airport and Kingstown | AVA', desc: 'Official taxi fares from Argyle airport and Kingstown to places across Saint Vincent, with after-hours fares.', path: '/fares/taxi', body }), 3600);
}
async function busPage() {
  const { data, error } = await supabase.from('bus_fares_official').select('hub, places, regular_fare');
  if (error) throw error; if (!data || !data.length) return notFound();
  const hubs = [...new Set(data.map(r => r.hub))].sort();
  const body = `<h1>Official bus fares in Saint Vincent</h1><p class="lead">Minibus fares from the main hubs. Students pay half fare.</p>` +
    hubs.map(h => `<h2>From ${esc(h)}</h2><div class="card"><table><tr><th>To</th><th>Fare</th></tr>${data.filter(r => r.hub === h).sort((a, b) => String(a.places[0]).localeCompare(String(b.places[0]))).map(r => `<tr><td>${esc((r.places || []).join(', '))}</td><td>${esc(money(r.regular_fare))}</td></tr>`).join('')}</table></div>`).join('');
  return page(200, shell({ title: 'Bus fares in Saint Vincent from Kingstown and other hubs | AVA', desc: 'Official minibus fares from Kingstown, Georgetown, Barrouallie, Paget Farm and Port Elizabeth.', path: '/fares/bus', body }), 3600);
}
async function ferryPage() {
  const { data: routes, error } = await supabase.from('ferry_routes').select('id, operator_name, origin_port, destination_port').eq('active', true);
  if (error) throw error; if (!routes || !routes.length) return notFound();
  const { data: sch, error: e2 } = await supabase.from('ferry_schedules').select('route_id, day_of_week, departure_time, fare_economy, last_verified_at').in('route_id', routes.map(r => r.id)).order('departure_time', { ascending: true });
  if (e2) throw e2;
  const t12 = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); if (!m) return esc(t); const h = +m[1]; return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`; };
  const body = `<h1>Ferry schedules from Saint Vincent</h1><p class="lead">Departure times by day for the Grenadines routes AVA has checked.</p>` +
    routes.map(r => { const rows = (sch || []).filter(s => s.route_id === r.id); if (!rows.length) return ''; const fare = rows.find(s => s.fare_economy != null); const ver = rows.map(s => s.last_verified_at).filter(Boolean).sort().pop();
      return `<h2>${esc(r.origin_port)} to ${esc(r.destination_port)} <span class="note">${esc(r.operator_name)}</span></h2><div class="card"><table>${DAYS.map((d, i) => { const t = rows.filter(s => s.day_of_week === i).map(s => t12(s.departure_time)); return t.length ? `<tr><th>${d}</th><td>${t.join(', ')}</td></tr>` : ''; }).join('')}</table>${fare ? `<div class="note">Economy fare ${esc(money(fare.fare_economy))}</div>` : ''}${ver ? `<div class="note">Last checked ${esc(daysAgo(ver))}. Schedules change, so confirm with the operator.</div>` : ''}</div>`; }).join('');
  return page(200, shell({ title: 'Ferry schedules in Saint Vincent and the Grenadines | AVA', desc: 'Ferry departure times and fares between Saint Vincent and the Grenadines, by day of the week.', path: '/ferry', body }), 1800);
}

// ---------- prices ----------
async function liveOffers() {
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const { data: offers, error } = await supabase.from('retail_offers').select('id, item_name, price, unit, listing_id, canonical_product_id, created_at, price_per_standard_unit, standard_unit_type').in('review_status', ['auto_published', 'approved']).gte('created_at', since).order('created_at', { ascending: false }).limit(2000);
  if (error) throw error; if (!offers || !offers.length) return [];
  const ids = [...new Set(offers.map(o => o.listing_id).filter(Boolean))];
  const { data: ls } = await supabase.from('directory_listings').select('id, name, island, subscribed_until, status').in('id', ids);
  const L = Object.fromEntries((ls || []).filter(l => l.status === 'active' && l.subscribed_until && new Date(l.subscribed_until) > new Date()).map(l => [l.id, l]));
  const pids = [...new Set(offers.map(o => o.canonical_product_id).filter(Boolean))];
  const { data: ps } = pids.length ? await supabase.from('canonical_products').select('id, name').in('id', pids) : { data: [] };
  const P = Object.fromEntries((ps || []).map(p => [p.id, p.name]));
  const seen = new Set(), out = [];
  for (const o of offers) { const l = L[o.listing_id]; if (!l) continue; const key = o.listing_id + '|' + (o.canonical_product_id || o.item_name); if (seen.has(key)) continue; seen.add(key); out.push({ ...o, listing: l, product: P[o.canonical_product_id] || o.item_name }); }
  return out;
}
async function pricesIndex() {
  const offers = await liveOffers(); const m = new Map();
  for (const o of offers) { const sl = slugify(o.product); if (!sl) continue; const e = m.get(sl) || { name: o.product, n: 0 }; e.n++; m.set(sl, e); }
  const list = [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  const body = `<h1>Prices from shops in Saint Vincent</h1><p class="lead">Prices posted by shops on AVA in the last 60 days.</p>` + (list.length ? `<div class="card">${list.map(([sl, e]) => `<a href="/prices/${esc(sl)}" style="display:inline-block;margin:4px 12px 4px 0">${esc(e.name)} <span class="note">(${e.n})</span></a>`).join('')}</div>` : '<p>No current prices yet.</p>');
  return page(200, shell({ title: 'Shop prices in Saint Vincent | AVA', desc: 'Current prices from shops across Saint Vincent and the Grenadines, posted by the shops themselves on AVA.', path: '/prices', body }), 600);
}
async function priceProduct(slug) {
  const offers = (await liveOffers()).filter(o => slugify(o.product) === slug); if (!offers.length) return notFound();
  offers.sort((a, b) => Number(a.price) - Number(b.price));
  const name = offers[0].product, cheapest = Number(offers[0].price);
  const body = `<h1>${esc(name)} prices in Saint Vincent</h1><p class="lead">${offers.length} shop${offers.length > 1 ? 's' : ''} on AVA, cheapest first.</p>` + offers.map((o, i) => `<div class="card"><div class="row"><span><b><a href="/l/${esc(o.listing_id)}">${esc(o.listing.name)}</a></b>${o.listing.island ? ` <span class="note">${esc(o.listing.island)}</span>` : ''}<br><span class="note">${esc(o.item_name)}${o.unit ? ' per ' + esc(o.unit) : ''} &middot; updated ${esc(daysAgo(o.created_at))}</span></span><b>${i === 0 && offers.length > 1 ? '<span class="tag">Lowest</span> ' : ''}${esc(money(o.price))}</b></div></div>`).join('');
  const units = new Set(offers.map(o => o.unit || ''));
  const ld = units.size === 1 && offers.length > 1 ? { '@context': 'https://schema.org', '@type': 'Product', name, offers: { '@type': 'AggregateOffer', priceCurrency: 'XCD', lowPrice: cheapest, highPrice: Number(offers[offers.length - 1].price), offerCount: offers.length } } : undefined;
  return page(200, shell({ title: `${name} price in Saint Vincent: compare shops | AVA`, desc: `${name} prices from ${offers.length} shop${offers.length > 1 ? 's' : ''} in Saint Vincent, from ${money(cheapest)}. Posted by the shops on AVA.`, path: `/prices/${slug}`, body, ld }), 600);
}

// ---------- directory ----------
async function directoryIndex() {
  const body = `<h1>Saint Vincent and the Grenadines business directory</h1><p class="lead">Businesses listed on AVA.</p><div class="card">${Object.entries(CATEGORIES).map(([k, c]) => `<div class="row"><a href="/directory/${k}">${esc(c.title)}</a></div>`).join('')}</div>`;
  return page(200, shell({ title: 'Business directory for Saint Vincent and the Grenadines | AVA', desc: 'Restaurants, pharmacies, doctors, taxis, car rentals, places to stay and more in Saint Vincent and the Grenadines.', path: '/directory', body }), 3600);
}
async function directoryCat(slug) {
  const c = CATEGORIES[slug]; if (!c) return notFound();
  const { data, error } = await supabase.from('directory_listings').select('id, name, address, island, phone').eq('category', c.db).eq('status', 'active').order('name', { ascending: true }).limit(300);
  if (error) throw error; if (!data || !data.length) return notFound();
  const body = `<h1>${esc(c.title)} in Saint Vincent and the Grenadines</h1><p class="lead">${data.length} listed on AVA.</p>` + data.map(l => `<div class="card"><b><a href="/l/${esc(l.id)}">${esc(l.name)}</a></b>${l.island ? ` <span class="note">${esc(l.island)}</span>` : ''}${l.address ? `<div class="note">${esc(l.address)}</div>` : ''}${l.phone ? `<div class="note">Tel ${esc(l.phone)}</div>` : ''}</div>`).join('');
  return page(200, shell({ title: `${c.title} in Saint Vincent and the Grenadines | AVA`, desc: `${data.length} ${c.title.toLowerCase()} in Saint Vincent and the Grenadines, with addresses and phone numbers.`, path: `/directory/${slug}`, body }), 3600);
}

// ---------- sitemap ----------
async function sitemap() {
  const urls = ['/', '/food', '/prices', '/fares/taxi', '/fares/bus', '/ferry', '/directory', ...Object.keys(CATEGORIES).map(k => '/directory/' + k)];
  try {
    const { data } = await supabase.from('directory_listings').select('id').eq('status', 'active').limit(5000);
    (data || []).forEach(l => urls.push('/l/' + l.id));
    [...dishIndex(await menuListings()).keys()].forEach(s => urls.push('/food/' + s));
    const seen = new Set(); (await liveOffers()).forEach(o => { const s = slugify(o.product); if (s && !seen.has(s)) { seen.add(s); urls.push('/prices/' + s); } });
  } catch (e) { console.error('sitemap partial:', e.message); }
  const today = new Date().toISOString().slice(0, 10);
  return { statusCode: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300, s-maxage=3600' }, body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u => `<url><loc>${esc(SITE + u)}</loc><lastmod>${today}</lastmod></url>`).join('')}</urlset>` };
}

exports.handler = async (event) => {
  try {
    let p = ''; try { p = new URL(event.rawUrl).pathname; } catch (e) { p = event.path || ''; }
    p = decodeURIComponent(p).replace(/^\/\.netlify\/functions\/seo-pages/, '').replace(/\/+$/, '') || '/';
    let m;
    if (p === '/sitemap.xml') return await sitemap();
    if (p === '/food') return await foodIndex();
    if ((m = /^\/food\/([a-z0-9-]{1,60})$/.exec(p))) return await foodPage(m[1]);
    if (p === '/fares/taxi') return await taxiPage();
    if (p === '/fares/bus') return await busPage();
    if (p === '/ferry') return await ferryPage();
    if (p === '/prices') return await pricesIndex();
    if ((m = /^\/prices\/([a-z0-9-]{1,60})$/.exec(p))) return await priceProduct(m[1]);
    if (p === '/directory') return await directoryIndex();
    if ((m = /^\/directory\/([a-z-]{1,30})$/.exec(p))) return await directoryCat(m[1]);
    return notFound();
  } catch (e) {
    console.error('seo-pages error:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body: 'Something went wrong. Please try again in a moment.' };
  }
};
