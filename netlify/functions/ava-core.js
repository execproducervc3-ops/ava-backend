// ava-core.js — the shared, reusable business logic behind AVA's tools.
// Extracted from ava-chat.js specifically so mcp-server.mjs can import it
// directly, rather than importing ava-chat.js as a whole (a full Netlify
// function file with its own HTTP handler), which caused real, confirmed
// esbuild bundling failures — the exact class of bug this separation
// exists to avoid. Both ava-chat.js (the conversational tool-use loop) and
// mcp-server.mjs (the MCP server) import from this same file, so there is
// genuinely one implementation, not two copies that could drift apart.

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// One-way hash for anonymous product-interest tracking — the raw device ID
// is never stored anywhere, only this hash, which cannot be reversed back
// to the original value.
function hashDeviceId(deviceId){
  if(!deviceId) return null;
  return crypto.createHash('sha256').update('ava-interest-salt:' + deviceId).digest('hex');
}

// Small, self-contained — deliberately NOT importing telegram-webhook.js's
// sendMessage. Requiring a whole other Netlify function file as a
// dependency is exactly the pattern that caused the real, confirmed
// esbuild bundling failures earlier tonight. A tiny duplicate here is the
// safe, proven fix for that class of problem.
async function sendTelegramLead(chatId, text){
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if(!token) return false;
  try{
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return res.ok;
  } catch(err){
    console.error('sendTelegramLead error:', err);
    return false;
  }
}

// Facilitates a customer lead to a paid-tier business — deliberately NOT a
// booking or reservation. No availability check, no payment, no confirmed
// status. AVA makes the introduction; the business owns everything after
// that, the same as an informal phone inquiry would today.
async function requestFromBusiness(listingId, offerId, requesterName, requesterContact, details){
  try{
    const { data: listing } = await supabase.from('directory_listings').select('id, name, subscription_tier, phone').eq('id', listingId).maybeSingle();
    if(!listing){
      return { ok: false, note: "Couldn't find that business." };
    }
    if(listing.subscription_tier !== 'paid'){
      return { ok: false, note: `Request routing isn't available for ${listing.name} yet — but here's their contact info if you'd like to reach out directly: ${listing.phone || 'not on file'}.` };
    }

    const { data: profile } = await supabase.from('retailer_profile').select('telegram_user_id').eq('directory_listing_id', listingId).maybeSingle();

    const { data: request } = await supabase.from('booking_requests').insert({
      listing_id: listingId,
      offer_id: offerId || null,
      requester_name: requesterName || null,
      requester_contact: requesterContact,
      details,
      status: profile ? 'sent_to_business' : 'no_channel_available',
    }).select().maybeSingle();

    if(!profile || !profile.telegram_user_id){
      return { ok: true, routed: false, note: `${listing.name} isn't reachable through AVA directly yet — here's their contact info: ${listing.phone || 'not on file'}.` };
    }

    const leadMessage = `New customer lead via AVA!\n\n${details}\n\nFrom: ${requesterName || 'A customer'}\nContact: ${requesterContact}`;
    const sent = await sendTelegramLead(profile.telegram_user_id, leadMessage);

    if(!sent){
      await supabase.from('booking_requests').update({ status: 'no_channel_available' }).eq('id', request.id);
      return { ok: true, routed: false, note: `Couldn't reach ${listing.name} directly right now — here's their contact info: ${listing.phone || 'not on file'}.` };
    }

    return { ok: true, routed: true, note: `Passed your request straight to ${listing.name} — they'll follow up with you directly.` };
  } catch(err){
    console.error('requestFromBusiness error:', err);
    return { ok: false, note: 'Something went wrong sending that request.' };
  }
}

function buildDeepLink(service_type, params){
  params = params || {};
  if(service_type === 'flights'){
    const q = encodeURIComponent(`Flights from ${params.origin||''} to ${params.destination||'Argyle International Airport'}${params.date ? ' on ' + params.date : ''}`.trim());
    return { url: `https://www.google.com/travel/flights?q=${q}`, name: 'Search on Google Flights', label: 'Flights' };
  }
  if(service_type === 'hotels'){
    const ss = encodeURIComponent(params.location || 'Saint Vincent and the Grenadines');
    let url = `https://www.booking.com/searchresults.html?ss=${ss}`;
    if(params.checkin) url += `&checkin=${encodeURIComponent(params.checkin)}`;
    if(params.checkout) url += `&checkout=${encodeURIComponent(params.checkout)}`;
    return { url, name: 'Search on Booking.com', label: 'Hotels' };
  }
  if(service_type === 'cars'){
    const loc = encodeURIComponent(params.location || 'Saint Vincent and the Grenadines');
    return { url: `https://www.rentalcars.com/search-results?location=${loc}`, name: 'Search on Rentalcars', label: 'Car rental' };
  }
  if(service_type === 'events'){
    const loc = encodeURIComponent(params.location || 'Saint Vincent and the Grenadines');
    const q = encodeURIComponent(params.query || '');
    return { url: `https://www.eventbrite.com/d/${loc}/${q}/`, name: 'Browse on Eventbrite', label: 'Events' };
  }
  if(service_type === 'customs_general'){
    return { url: 'https://customs.gov.vc/general-calculator.php', name: 'Official SVG Customs Duty Calculator', label: 'Customs duty' };
  }
  if(service_type === 'customs_vehicle'){
    return { url: 'https://customs.gov.vc/vehicle-calculator', name: 'Official SVG Vehicle Import Duty Calculator', label: 'Vehicle import duty' };
  }
  if(service_type === 'voter_registration'){
    // Real, confirmed filenames from the Electoral Office's own voters-list
    // page — not guessed. Each constituency's alphabetical voters list is a
    // separate static PDF, not a live search.
    const CONSTITUENCY_PDF = {
      'central kingstown': 'ckalpha', 'central leeward': 'clalpha', 'east kingstown': 'ekalpha',
      'east st george': 'egalpha', 'east st. george': 'egalpha', 'marriaqua': 'mqalpha',
      'north central windward': 'ncalpha', 'north leeward': 'nlalpha', 'north windward': 'nwalpha',
      'northern grenadines': 'ngalpha', 'south central windward': 'scalpha', 'south leeward': 'slalpha',
      'south windward': 'swalpha', 'southern grenadines': 'sgalpha', 'west kingstown': 'wkalpha',
      'west st george': 'wgalpha', 'west st. george': 'wgalpha',
    };
    const key = (params.location || '').trim().toLowerCase();
    const prefix = CONSTITUENCY_PDF[key];
    if(prefix){
      return {
        url: `https://electoral.gov.vc/electoral/images/PDF/voters_list/2025/final_voters_list_Nov_2025/${prefix}.pdf`,
        name: `${params.location} Voters List (PDF)`,
        label: 'Voter registration',
      };
    }
    // No matching constituency given — link to the page listing all 15 so the person can pick theirs
    return { url: 'https://electoral.gov.vc/electoral/index.php/voters-list', name: 'SVG Voters List by Constituency', label: 'Voter registration' };
  }
  return null;
}

// Logs a real coverage gap — a specific ask that AVA's structured data couldn't
// satisfy. This is deliberately fire-and-forget: a logging failure must never
// break the actual user-facing answer.
async function logUnansweredQuery(queryText, categoryGuess){
  try{
    await supabase.from('unanswered_queries').insert({
      query_text: queryText,
      category_guess: categoryGuess,
    });
  } catch(err){
    console.error('logUnansweredQuery failed (non-fatal):', err.message);
  }
}

async function logProductInterest(searchTerm, deviceId){
  try{
    const hash = hashDeviceId(deviceId);
    if(!hash) return; // no device id on this request — skip rather than log an untraceable entry
    const { data: matches } = await supabase
      .from('canonical_products')
      .select('id')
      .ilike('name', `%${searchTerm}%`)
      .limit(1);
    const canonicalProductId = matches && matches.length ? matches[0].id : null;
    await supabase.from('product_interest_log').insert({
      canonical_product_id: canonicalProductId,
      search_term: searchTerm,
      device_id_hash: hash,
    });
  } catch(err){
    console.error('logProductInterest failed (non-fatal):', err.message);
  }
}

async function queryRetailPriceDB(productName){
  if(!productName || !productName.trim()) return { results: [], note: 'No product name given.' };
  try{
    const { data: products, error: prodErr } = await supabase
      .from('canonical_products')
      .select('id, name')
      .ilike('name', `%${productName.trim()}%`);
    if(prodErr) throw prodErr;
    if(!products || !products.length){
      await logUnansweredQuery(productName.trim(), 'retail_price');
      return { results: [], note: "No matching product found in AVA's database yet — this may not have been submitted by any retailer." };
    }
    const productIds = products.map(p => p.id);

    const { data: offers, error: offerErr } = await supabase
      .from('retail_offers')
      .select('id, item_name, price, unit, standard_unit_type, price_per_standard_unit, photo_url, listing_id, created_at')
      .in('canonical_product_id', productIds)
      .in('review_status', ['auto_published', 'approved'])
      .order('price_per_standard_unit', { ascending: true, nullsFirst: false })
      .order('price', { ascending: true });
    if(offerErr) throw offerErr;
    if(!offers || !offers.length){
      await logUnansweredQuery(productName.trim(), 'retail_price');
      return { results: [], note: 'That product exists in the database but no retailer currently has an offer for it.' };
    }

    const listingIds = [...new Set(offers.map(o => o.listing_id))];
    const { data: listings, error: listErr } = await supabase
      .from('directory_listings')
      .select('id, name, island, parish, address, phone')
      .in('id', listingIds);
    if(listErr) throw listErr;
    const listingMap = Object.fromEntries((listings || []).map(l => [l.id, l]));

    const results = offers.map(o => ({
      offer_id: o.id,
      listing_id: o.listing_id,
      retailer: (listingMap[o.listing_id] && listingMap[o.listing_id].name) || 'Unknown retailer',
      island: (listingMap[o.listing_id] && listingMap[o.listing_id].island) || null,
      parish: (listingMap[o.listing_id] && listingMap[o.listing_id].parish) || null,
      address: (listingMap[o.listing_id] && listingMap[o.listing_id].address) || null,
      phone: (listingMap[o.listing_id] && listingMap[o.listing_id].phone) || null,
      item_name: o.item_name,
      price: o.price,
      unit: o.unit,
      standard_unit_type: o.standard_unit_type,
      price_per_standard_unit: o.price_per_standard_unit,
      photo_url: o.photo_url,
    }));
    return { results };
  } catch(err){
    console.error('queryRetailPriceDB error:', err);
    return { results: [], note: 'Could not reach the price database right now.' };
  }
}

// For a real shopping list — several products in one request. Runs the
// same proven single-product lookup for each item in parallel, rather
// than requiring Claude to generate a separate tool call per item, which
// measurably added both generation and execution time to the request.
async function queryMultipleRetailPrices(productNames){
  if(!Array.isArray(productNames) || !productNames.length){
    return { items: [] };
  }
  const results = await Promise.all(productNames.map(async (name) => {
    const data = await queryRetailPriceDB(name);
    return { product: name, results: data.results || [], note: (!data.results || !data.results.length) ? data.note : null };
  }));
  return { items: results };
}

async function queryNewsDB(topic){
  const t = (topic || '').trim().toLowerCase();
  const isBrowseRequest = !t || ['news', 'latest', 'latest news', 'all', 'everything', 'general', 'recent', 'local news', 'current events', 'what\'s new'].includes(t);

  try{
    let data, error;
    let specificSearchFailed = false;

    if(!isBrowseRequest){
      // This is the actual enforcement point for the human-review gate designed
      // from the very first architecture session: no matter what the query is,
      // articles still sitting in draft/pending_review can never be returned here.
      ({ data, error } = await supabase
        .from('knowledge_articles')
        .select('topic, body, source_url, published_at')
        .eq('review_status', 'published')
        .or(`topic.ilike.%${topic.trim()}%,body.ilike.%${topic.trim()}%`)
        .order('published_at', { ascending: false })
        .limit(5));
      if(error) throw error;
      if(!data || !data.length) specificSearchFailed = true;
    }

    // Fall back to "most recent published" ONLY for a genuine browse-style
    // ask ("what's the latest news"), where showing recent general news is
    // literally what was requested. A specific, named-topic search that
    // came up empty must NOT fall back to this — silently substituting
    // unrelated recent articles (a real, confirmed production bug: a
    // "Vincy Mas 2026" search returned articles about land leases, the
    // NDB, and an unrelated politician's death) is actively misleading,
    // not a graceful degrade. An honest "nothing found" is the correct
    // answer for a failed specific search.
    if(isBrowseRequest){
      ({ data, error } = await supabase
        .from('knowledge_articles')
        .select('topic, body, source_url, published_at')
        .eq('review_status', 'published')
        .order('published_at', { ascending: false })
        .limit(5));
      if(error) throw error;
    }

    if(specificSearchFailed) await logUnansweredQuery(topic.trim(), 'news');

    if(specificSearchFailed) return { results: [], note: `No published news articles found on "${topic.trim()}" specifically.` };
    if(!data || !data.length) return { results: [], note: 'No published articles available yet.' };
    return { results: data };
  } catch(err){
    console.error('queryNewsDB error:', err);
    return { results: [], note: 'Could not reach the news database right now.' };
  }
}

const WB_COUNTRY_CODE = 'VCT'; // World Bank's ISO code for Saint Vincent and the Grenadines
const WB_INDICATOR_MAP = {
  'gdp': { code: 'NY.GDP.MKTP.CD', label: 'GDP (current US$)' },
  'gdp growth': { code: 'NY.GDP.MKTP.KD.ZG', label: 'GDP growth (annual %)' },
  'inflation': { code: 'FP.CPI.TOTL.ZG', label: 'Inflation, consumer prices (annual %)' },
  'unemployment': { code: 'SL.UEM.TOTL.ZS', label: 'Unemployment (% of total labor force)' },
  'population': { code: 'SP.POP.TOTL', label: 'Population, total' },
  'remittances': { code: 'BX.TRF.PWKR.DT.GD.ZS', label: 'Personal remittances received (% of GDP)' },
  'labor force participation': { code: 'SL.TLF.CACT.ZS', label: 'Labor force participation rate (% of population ages 15+, ILO modelled estimate)' },
  'tourism': { code: 'ST.INT.RCPT.CD', label: 'International tourism receipts (current US$)' },
  // Worldwide Governance Indicators (WGI) — a separate World Bank dataset from
  // the main World Development Indicators above, which is why these need the
  // extra source=3 parameter. Estimate scale runs roughly -2.5 (weak) to +2.5 (strong).
  'corruption control': { code: 'CC.EST', label: 'Control of Corruption (WGI estimate, -2.5 to 2.5)', source: 3 },
  'government effectiveness': { code: 'GE.EST', label: 'Government Effectiveness (WGI estimate, -2.5 to 2.5)', source: 3 },
  'political stability': { code: 'PV.EST', label: 'Political Stability and Absence of Violence (WGI estimate, -2.5 to 2.5)', source: 3 },
  'regulatory quality': { code: 'RQ.EST', label: 'Regulatory Quality (WGI estimate, -2.5 to 2.5)', source: 3 },
  'rule of law': { code: 'RL.EST', label: 'Rule of Law (WGI estimate, -2.5 to 2.5)', source: 3 },
  'voice and accountability': { code: 'VA.EST', label: 'Voice and Accountability (WGI estimate, -2.5 to 2.5)', source: 3 },
};

async function queryEconomicData(indicatorKey){
  const key = (indicatorKey || '').trim().toLowerCase();
  const info = WB_INDICATOR_MAP[key];
  if(!info){
    await logUnansweredQuery(`economic indicator: ${indicatorKey || '(empty)'}`, 'economic_data');
    return { note: `Unknown indicator "${indicatorKey}". Available: ${Object.keys(WB_INDICATOR_MAP).join(', ')}` };
  }
  try{
    const sourceParam = info.source ? `&source=${info.source}` : '';
    const url = `https://api.worldbank.org/v2/country/${WB_COUNTRY_CODE}/indicator/${info.code}?format=json&mrv=5${sourceParam}`;
    const res = await fetch(url);
    if(!res.ok) throw new Error(`World Bank API failed: ${res.status}`);
    const data = await res.json();
    // The World Bank API returns a 2-element array: [metadata, dataPoints].
    // dataPoints can be null if nothing exists for this country/indicator pair —
    // that's a real, expected case, not an error.
    const points = (Array.isArray(data) && data[1]) ? data[1] : [];
    const values = points
      .filter(p => p.value !== null && p.value !== undefined)
      .map(p => ({ year: p.date, value: p.value }))
      .sort((a, b) => b.year - a.year);

    if(!values.length){
      await logUnansweredQuery(`economic indicator: ${key} (no data returned)`, 'economic_data');
      return { indicator: info.label, values: [], note: 'No recent World Bank data available for this indicator.' };
    }
    return { indicator: info.label, values };
  } catch(err){
    console.error('queryEconomicData error:', err);
    return { note: 'Could not reach the World Bank data source right now.' };
  }
}

const IMF_COUNTRY_CODE = 'VCT'; // IMF's code for Saint Vincent and the Grenadines
const IMF_INDICATOR_MAP = {
  'gdp growth': { code: 'NGDP_RPCH', label: 'Real GDP growth (IMF World Economic Outlook, %)' },
  'inflation': { code: 'PCPIPCH', label: 'Inflation, average consumer prices (IMF WEO, %)' },
  'government debt': { code: 'GGXWDG_NGDP', label: 'General government gross debt (% of GDP)' },
  'current account': { code: 'BCA_NGDPD', label: 'Current account balance (% of GDP)' },
  'fiscal balance': { code: 'GGXCNL_NGDP', label: 'General government net lending/borrowing (% of GDP)' },
};

async function queryImfData(indicatorKey){
  const key = (indicatorKey || '').trim().toLowerCase();
  const info = IMF_INDICATOR_MAP[key];
  if(!info){
    await logUnansweredQuery(`IMF indicator: ${indicatorKey || '(empty)'}`, 'economic_data');
    return { note: `Unknown IMF indicator "${indicatorKey}". Available: ${Object.keys(IMF_INDICATOR_MAP).join(', ')}` };
  }
  try{
    const url = `https://www.imf.org/external/datamapper/api/v2/${info.code}/${IMF_COUNTRY_CODE}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AVA-SVG/1.0; +https://exquisite-empanada-841a01.netlify.app)' },
    });
    if(!res.ok) throw new Error(`IMF API failed: ${res.status}`);
    const data = await res.json();
    // The country filter in the URL is unreliable in practice — the API can
    // return every country regardless. Always extract VCT specifically from
    // the full response rather than trusting the request to have filtered it.
    const countryValues = (data && data.values && data.values[info.code]) ? data.values[info.code][IMF_COUNTRY_CODE] : null;
    if(!countryValues){
      await logUnansweredQuery(`IMF indicator: ${key} (no data returned)`, 'economic_data');
      return { indicator: info.label, values: [], note: 'No IMF data available for this indicator.' };
    }
    const currentYear = new Date().getFullYear();
    const values = Object.entries(countryValues)
      .filter(([, val]) => val !== null && val !== undefined)
      .map(([year, val]) => ({ year: parseInt(year, 10), value: val }))
      .filter(v => v.year <= currentYear + 1) // exclude far-future speculative projections beyond next year
      .sort((a, b) => b.year - a.year)
      .slice(0, 6);
    if(!values.length){
      await logUnansweredQuery(`IMF indicator: ${key} (no data returned)`, 'economic_data');
      return { indicator: info.label, values: [], note: 'No IMF data available for this indicator.' };
    }
    return { indicator: info.label, values };
  } catch(err){
    console.error('queryImfData error:', err);
    return { note: 'Could not reach the IMF data source right now.' };
  }
}

// Real, verified operator contact info — used only as a fallback when a
// destination has no confirmed schedule in the database yet, so "we don't
// know" still leaves the person somewhere useful to go, not a dead end.
const FERRY_OPERATOR_CONTACTS = 'Bequia Express (bequiaexpress.com), Admiral Ferries ((784) 458-3348, WhatsApp (784) 534-7707), Jaden Sun Fast Ferry (jadensunferry.com, (784) 451-2192)';

async function queryFerrySchedule(destination, dayOfWeek){
  const dest = (destination || '').trim();
  if(!dest) return { results: [], note: 'No destination given.' };
  try{
    const { data: routes, error: routeErr } = await supabase
      .from('ferry_routes')
      .select('id, operator_name, origin_port, destination_port')
      .eq('active', true)
      .ilike('destination_port', `%${dest}%`);
    if(routeErr) throw routeErr;
    if(!routes || !routes.length){
      await logUnansweredQuery(`ferry schedule: ${dest}`, 'ferry_schedule');
      return { results: [], note: `No confirmed ferry schedule for ${dest} in AVA's database yet. Known operators to contact directly: ${FERRY_OPERATOR_CONTACTS}.` };
    }

    const routeIds = routes.map(r => r.id);
    const { data: schedules, error: schedErr } = await supabase
      .from('ferry_schedules')
      .select('route_id, departure_time, fare_economy, last_verified_at')
      .in('route_id', routeIds)
      .eq('day_of_week', dayOfWeek)
      .order('departure_time', { ascending: true });
    if(schedErr) throw schedErr;
    if(!schedules || !schedules.length){
      await logUnansweredQuery(`ferry schedule: ${dest} on day_of_week ${dayOfWeek}`, 'ferry_schedule');
      return { results: [], note: `No sailings found for ${dest} on that day in AVA's database. Known operators to contact directly: ${FERRY_OPERATOR_CONTACTS}.` };
    }

    const routeMap = Object.fromEntries(routes.map(r => [r.id, r]));
    const results = schedules.map(s => ({
      operator: routeMap[s.route_id].operator_name,
      origin: routeMap[s.route_id].origin_port,
      destination: routeMap[s.route_id].destination_port,
      departure_time: s.departure_time,
      fare_economy: s.fare_economy,
      last_verified_at: s.last_verified_at,
    }));
    return { results };
  } catch(err){
    console.error('queryFerrySchedule error:', err);
    return { results: [], note: 'Could not reach the ferry schedule database right now.' };
  }
}

function randInt(min, max){
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickUniqueNumbers(count, min, max){
  const pool = [];
  while(pool.length < count){
    const n = randInt(min, max);
    if(!pool.includes(n)) pool.push(n);
  }
  return pool.sort((a, b) => a - b);
}

function randomLetterAtoO(){
  const letters = 'ABCDEFGHIJKLMNO';
  return letters[randInt(0, letters.length - 1)];
}

function padDigits(n, len){
  return String(n).padStart(len, '0');
}

function generateLuckyNumbers(game){
  const key = (game || '').trim().toLowerCase();

  if(key === 'super6'){
    return {
      game: 'Super 6',
      numbers: pickUniqueNumbers(6, 1, 28),
      bonusLetter: randomLetterAtoO(),
    };
  }

  if(key === 'lotto'){
    const numbers = pickUniqueNumbers(5, 1, 36);
    return {
      game: 'Lotto',
      numbers,
      bonusBall: randInt(1, 36),
      bonusLetter: randomLetterAtoO(),
    };
  }

  if(key === '3d'){
    // A real 3D draw produces three separate 3-digit results, not one —
    // confirmed from an actual NLA draw post (Big-D / Mid-D / Little-D).
    return {
      game: '3D',
      bigD: padDigits(randInt(0, 999), 3),
      midD: padDigits(randInt(0, 999), 3),
      littleD: padDigits(randInt(0, 999), 3),
    };
  }

  if(key === 'play4'){
    const digits = [randInt(0, 9), randInt(0, 9), randInt(0, 9), randInt(0, 9)];
    return { game: 'Play 4', digits };
  }

  return { note: `Unknown game "${game}". Available: super6, lotto, 3d, play4.` };
}

async function queryPointsOfInterest(category, island, placeName){
  try{
    let query = supabase
      .from('points_of_interest')
      .select('name, category, island, description, source_url')
      .eq('active', true);

    if(category && category.trim()){
      query = query.eq('category', category.trim());
    }
    if(island && island.trim()){
      query = query.ilike('island', `%${island.trim()}%`);
    }
    if(placeName && placeName.trim()){
      query = query.ilike('name', `%${placeName.trim()}%`);
    }

    const { data, error } = await query.order('name', { ascending: true }).limit(15);
    if(error) throw error;

    if(!data || !data.length){
      await logUnansweredQuery(`points_of_interest: ${category || 'any'}${island ? ' in ' + island : ''}${placeName ? ' named ' + placeName : ''}`, 'points_of_interest');
      return { results: [], note: `No matching attractions found in AVA's database yet${island ? ' for ' + island : ''}.` };
    }

    return { results: data };
  } catch(err){
    console.error('queryPointsOfInterest error:', err);
    return { results: [], note: 'Could not reach the attractions database right now.' };
  }
}

// Orchestrates a full trip plan from one total budget — flights via Duffel
// (the one category with no local alternative), everything else from AVA's
// own directory listings, since local accommodation and car rental agencies
// are the actually-relevant options for SVG, not international chains.
// Real, priced accommodation/vehicle-rental options — distinct from
// queryDirectory, which only returns bare business listings with no price
// at all. Joins retail_offers (where the actual rate lives, since a
// listing_type-classified submission carries a real price) with
// directory_listings for the business name, sorted cheapest first.
async function queryPricedListings(listingType, island){
  try{
    let query = supabase
      .from('retail_offers')
      .select('item_name, price, unit, photo_url, listing_id, directory_listings!inner(name, island)')
      .eq('listing_type', listingType)
      .in('review_status', ['auto_published', 'approved']);

    if(island && island.trim()){
      query = query.ilike('directory_listings.island', `%${island.trim()}%`);
    }

    const { data, error } = await query.order('price', { ascending: true }).limit(10);
    if(error) throw error;

    if(!data || !data.length){
      return { results: [], note: `No priced ${listingType === 'accommodation_rate' ? 'accommodation' : 'vehicle rental'} listings yet${island ? ' for ' + island : ''}.` };
    }

    return {
      results: data.map(r => ({
        name: r.item_name,
        retailer: r.directory_listings ? r.directory_listings.name : null,
        island: r.directory_listings ? r.directory_listings.island : null,
        price: r.price,
        unit: r.unit,
        photo_url: r.photo_url,
      })),
    };
  } catch(err){
    console.error('queryPricedListings error:', err);
    return { results: [], note: 'Could not reach the listings database right now.' };
  }
}

async function planTrip(origin, destination, departureDate, totalBudget, island){
  const { queryDuffelFlights } = require('./duffel-flights.js');

  // Real, defensible starting split — not arbitrary, a commonly-used travel
  // budgeting heuristic: flights and lodging dominate, food and transport
  // are smaller shares.
  const budgetSplit = {
    flights: totalBudget * 0.35,
    accommodation: totalBudget * 0.30,
    car_rental: totalBudget * 0.15,
    food: totalBudget * 0.20,
  };

  const [flightResults, accommodationResults, carResults, foodResults] = await Promise.all([
    queryDuffelFlights(origin, destination, departureDate, 1),
    queryPricedListings('accommodation_rate', island),
    queryPricedListings('vehicle_rate', island),
    queryDirectory('restaurant', island),
  ]);

  return {
    budget_split: budgetSplit,
    flights: flightResults,
    accommodation: accommodationResults,
    car_rental: carResults,
    food: foodResults,
  };
}

// Derived directly from the official table's own internal structure — every
// one of the 10 distinct real fare values fits exactly (to the nearest
// dollar) against $39 base + $6.50 per step, confirmed by checking each
// value in code, not estimated from any external distance source.
const TAXI_FARE_SLOPE = 6.50;
const TAXI_FARE_INTERCEPT = 39.00;

// Real, general-purpose taxi fare estimation for anywhere in SVG — not just
// the ~16 places named in the official table. Geocodes both points, gets a
// REAL driving distance (not straight-line, which would be badly wrong on
// this island's terrain — confirmed earlier tonight, AIA-Kingstown is only
// ~5.2mi by air but 10.5mi by actual road), then applies the same formula
// derived from the official table's own internal structure.
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

async function geocodePlace(placeName){
  const query = /svg|vincent/i.test(placeName) ? placeName : `${placeName}, Saint Vincent and the Grenadines`;
  // Places' Find Place From Text, not the plain Geocoding API — geocoding is
  // built for structured addresses and can resolve informal/landmark names
  // like "Indian Bay" to an imprecise area centroid (sometimes over water),
  // which a driving-route engine then can't route to at all. Places search
  // is built specifically for this kind of informal query, with a location
  // bias circle constrained to SVG so it doesn't match a same-named place
  // elsewhere in the world.
  const params = new URLSearchParams({
    input: query,
    inputtype: 'textquery',
    fields: 'geometry',
    locationbias: 'circle:40000@13.25,-61.20', // ~40km around SVG's main islands
    key: GOOGLE_KEY,
  });
  const res = await fetch(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?${params}`);
  if(!res.ok) throw new Error(`Places lookup request failed: ${res.status}`);
  const data = await res.json();

  if(data.status === 'OK' && data.candidates && data.candidates.length){
    return { location: data.candidates[0].geometry.location, status: 'OK' };
  }

  console.error(`Places lookup non-OK status for "${query}":`, data.status, data.error_message || '');
  return { location: null, status: data.status };
}

async function getRealDrivingDistanceMiles(originLatLng, destLatLng){
  const requestBody = {
    origin: { location: { latLng: { latitude: originLatLng.lat, longitude: originLatLng.lng } } },
    destination: { location: { latLng: { latitude: destLatLng.lat, longitude: destLatLng.lng } } },
    travelMode: 'DRIVE',
  };
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': 'routes.distanceMeters',
    },
    body: JSON.stringify(requestBody),
  });
  if(!res.ok){
    const errBody = await res.text().catch(() => '');
    console.error(`Routes API non-OK status ${res.status} for real driving distance lookup:`, errBody, '| coordinates used:', JSON.stringify(requestBody));
    throw new Error(`Routes request failed: ${res.status}`);
  }
  const data = await res.json();
  if(!data.routes || !data.routes.length){
    // Log the exact coordinates alongside the empty response — this is the
    // detail that distinguishes "bad field mask" from "these coordinates
    // genuinely aren't a routable pair," which look identical otherwise.
    console.error('Routes API returned OK but with no routes array:', JSON.stringify(data), '| coordinates used:', JSON.stringify(requestBody));
    return null;
  }
  return data.routes[0].distanceMeters / 1609.34; // meters to miles
}

function findOfficialFareRow(rows, placeName){
  const needle = placeName.trim().toLowerCase();
  return rows.find(r => r.places.some(p => p.toLowerCase().includes(needle) || needle.includes(p.toLowerCase())));
}

async function queryTaxiFare(origin, destination){
  try{
    const { data: rows, error } = await supabase.from('taxi_fares_official')
      .select('places, regular_fare, after_hours_fare, origin_type, passenger_tier, trip_type, additional_passenger_fee');
    if(error) throw error;
    if(!rows || !rows.length) return { note: 'No official taxi fare data available.' };

    const isAirport = (s) => /\b(aia|argyle|airport|svd)\b/i.test(s);
    const isKingstown = (s) => /\bkingstown\b/i.test(s);
    const isCruiseShip = (s) => /\b(cruise ship|cruise berth|the berth|ship berth)\b/i.test(s);

    // Priority 1: airport routes — the most complete official data (43
    // named places), flat rate for 1-3 passengers plus a fixed EC$13
    // per additional passenger.
    if(isAirport(origin) || isAirport(destination)){
      const place = isAirport(origin) ? destination : origin;
      const match = findOfficialFareRow(rows.filter(r => r.origin_type === 'airport'), place);
      if(match){
        return {
          type: 'official', origin_type: 'airport', place: match.places.join(', '),
          regular_fare: match.regular_fare, after_hours_fare: match.after_hours_fare,
          additional_passenger_fee: match.additional_passenger_fee,
        };
      }
    }

    // Priority 2: Kingstown-origin routes — priced per passenger, a
    // genuinely different structure from the airport table.
    if(isKingstown(origin) || isKingstown(destination)){
      const place = isKingstown(origin) ? destination : origin;
      const match = findOfficialFareRow(rows.filter(r => r.origin_type === 'kingstown'), place);
      if(match){
        return {
          type: 'official', origin_type: 'kingstown', place: match.places.join(', '),
          regular_fare: match.regular_fare, after_hours_fare: match.after_hours_fare,
          per_passenger: true,
        };
      }
    }

    // Priority 3: cruise ship berth — tiered by group size (1-4, 5-10,
    // over 10), with separate one-way/return rates. Only the one-way
    // after-hours figure is published; return after-hours genuinely isn't.
    if(isCruiseShip(origin) || isCruiseShip(destination)){
      const place = isCruiseShip(origin) ? destination : origin;
      const matches = rows.filter(r => r.origin_type === 'cruise_ship_berth'
        && r.places.some(p => p.toLowerCase().includes(place.toLowerCase()) || place.toLowerCase().includes(p.toLowerCase())));
      if(matches.length){
        return { type: 'official_tiered', origin_type: 'cruise_ship_berth', place, tiers: matches };
      }
    }

    // General case: real geocoding + real driving distance, covering
    // anywhere in SVG. The derived rate ($39 + $6.50/mile) fits every real
    // official value exactly up to about 20 miles — beyond that (remote
    // leeward and far-windward destinations like Owia, Troumaca, Richmond),
    // the real published fares deviate from a straight linear relationship,
    // since those routes involve winding coastal mountain roads that don't
    // scale the same way. Long-distance estimates are honestly less precise.
    const [originGeo, destGeo] = await Promise.all([geocodePlace(origin), geocodePlace(destination)]);
    const failed = !originGeo.location ? originGeo : (!destGeo.location ? destGeo : null);
    if(failed){
      const failedPlace = !originGeo.location ? origin : destination;
      if(failed.status === 'ZERO_RESULTS'){
        return { note: `Could not find "${failedPlace}" — check the spelling, or it may be too small/unnamed to geocode.` };
      }
      return { note: `AVA's map lookup isn't working right now (${failed.status}) — this is a setup issue on AVA's side, not a problem with "${failedPlace}" itself.` };
    }
    const realMiles = await getRealDrivingDistanceMiles(originGeo.location, destGeo.location);
    if(realMiles === null){
      return { note: `Could not calculate a real driving route between "${origin}" and "${destination}".` };
    }
    const estimatedFare = TAXI_FARE_INTERCEPT + TAXI_FARE_SLOPE * realMiles;

    // Falling through to here means none of the official tables (airport,
    // Kingstown, cruise ship) covered this route — worth tracking as a real
    // gap, since it means only an estimate exists for a route someone
    // actually asked about.
    await logUnansweredQuery(`taxi fare: ${origin} to ${destination} (no official rate, estimate only)`, 'taxi_fare');

    return {
      type: 'estimate',
      origin, destination,
      real_distance_miles: +realMiles.toFixed(1),
      estimated_fare: +estimatedFare.toFixed(2),
      long_distance_caveat: realMiles > 18, // formula fit stops being exact beyond this range in the real data
    };
  } catch(err){
    console.error('queryTaxiFare error:', err);
    return { note: 'Could not reach the taxi fare data right now.' };
  }
}

async function querySettlementClassification(placeName){
  try{
    const { data, error } = await supabase.from('settlement_classifications')
      .select('name, typology, spatial_strategy')
      .ilike('name', `%${placeName.trim()}%`)
      .limit(1)
      .maybeSingle();
    if(error) throw error;
    if(!data){
      await logUnansweredQuery(`settlement classification: ${placeName.trim()}`, 'settlement_classification');
      return { note: `"${placeName}" isn't in the official settlement hierarchy classification (National Physical Development Plan, 2021 draft) — likely too small to be individually classified, or it's a Grenadines island outside mainland-focused Table 1.` };
    }
    return { type: 'official', name: data.name, typology: data.typology, spatial_strategy: data.spatial_strategy };
  } catch(err){
    console.error('querySettlementClassification error:', err);
    return { note: 'Could not reach the settlement classification data right now.' };
  }
}

async function queryBusFare(origin, destination){
  try{
    const { data: rows, error } = await supabase.from('bus_fares_official').select('hub, places, regular_fare');
    if(error) throw error;
    if(!rows || !rows.length) return { note: 'No official bus fare data available.' };

    const hubMatch = ['Kingstown', 'Georgetown', 'Barrouallie', 'Paget Farm', 'Port Elizabeth']
      .find(hub => origin.toLowerCase().includes(hub.toLowerCase()) || destination.toLowerCase().includes(hub.toLowerCase()));
    if(!hubMatch){
      await logUnansweredQuery(`bus fare: ${origin} to ${destination} (no matching hub)`, 'bus_fare');
      return { note: `Bus fares are published relative to specific hubs (Kingstown, Georgetown, Barrouallie, Paget Farm, Port Elizabeth) — neither "${origin}" nor "${destination}" matches one of these.` };
    }
    const place = origin.toLowerCase().includes(hubMatch.toLowerCase()) ? destination : origin;
    const match = findOfficialFareRow(rows.filter(r => r.hub === hubMatch), place);
    if(!match){
      await logUnansweredQuery(`bus fare: ${place} from ${hubMatch} hub`, 'bus_fare');
      return { note: `"${place}" isn't in the official bus fare list for the ${hubMatch} hub.` };
    }
    return {
      type: 'official', hub: hubMatch, place: match.places.join(', '),
      regular_fare: match.regular_fare, student_fare: +(match.regular_fare * 0.5).toFixed(2),
    };
  } catch(err){
    console.error('queryBusFare error:', err);
    return { note: 'Could not reach the bus fare data right now.' };
  }
}

async function queryDirectory(category, island, businessName){
  try{
    let query = supabase
      .from('directory_listings')
      .select('id, name, address, island, phone, category, is_top_pick, top_pick_note')
      .eq('category', category)
      .eq('status', 'active');

    if(island && island.trim()){
      query = query.ilike('island', `%${island.trim()}%`);
    }
    if(businessName && businessName.trim()){
      query = query.ilike('name', `%${businessName.trim()}%`);
    }

    const { data, error } = await query.order('is_top_pick', { ascending: false }).order('name', { ascending: true }).limit(50);
    if(error) throw error;

    if(!data || !data.length){
      await logUnansweredQuery(`directory: ${category}${island ? ' in ' + island : ''}`, 'directory');
      return { results: [], note: `No ${category.replace('_', ' ')} listings found${island ? ' in ' + island : ''} in AVA's directory yet.` };
    }

    return { results: data };
  } catch(err){
    console.error('queryDirectory error:', err);
    return { results: [], note: 'Could not reach the directory right now.' };
  }
}

const WHO_COUNTRY_CODE = 'VCT'; // WHO GHO uses ISO3 codes, same as World Bank/IMF
const WHO_INDICATOR_MAP = {
  'life expectancy': { code: 'WHOSIS_000001', label: 'Life expectancy at birth (years)' },
};

async function queryHealthData(indicatorKey){
  const key = (indicatorKey || '').trim().toLowerCase();
  const info = WHO_INDICATOR_MAP[key];
  if(!info){
    await logUnansweredQuery(`WHO health indicator: ${indicatorKey || '(empty)'}`, 'health_data');
    return { note: `Unknown health indicator "${indicatorKey}". Available: ${Object.keys(WHO_INDICATOR_MAP).join(', ')}` };
  }
  try{
    const filterParam = encodeURIComponent(`SpatialDim eq '${WHO_COUNTRY_CODE}'`);
    const url = `https://ghoapi.azureedge.net/api/${info.code}?$filter=${filterParam}`;
    const res = await fetch(url);
    if(!res.ok) throw new Error(`WHO GHO API failed: ${res.status}`);
    const data = await res.json();
    // OData response shape: { '@odata.context': '...', value: [ {SpatialDim, TimeDim, NumericValue, Dim1, ...} ] }
    const records = (data && Array.isArray(data.value)) ? data.value : [];
    const withValues = records.filter(r => r.NumericValue !== null && r.NumericValue !== undefined);
    // Many indicators are broken down by sex (Dim1: 'MLE'/'FMLE'/'BTSX'). Prefer
    // the combined "both sexes" figure when available, rather than mixing all three.
    const bothSexes = withValues.filter(r => !r.Dim1 || r.Dim1 === 'BTSX');
    const useRecords = bothSexes.length ? bothSexes : withValues;

    const values = useRecords
      .map(r => ({ year: r.TimeDim, value: r.NumericValue }))
      .sort((a, b) => b.year - a.year)
      .slice(0, 5);

    if(!values.length){
      await logUnansweredQuery(`WHO health indicator: ${key} (no data returned)`, 'health_data');
      return { indicator: info.label, values: [], note: 'No WHO data available for this indicator.' };
    }
    return { indicator: info.label, values };
  } catch(err){
    console.error('queryHealthData error:', err);
    return { note: 'Could not reach the WHO data source right now.' };
  }
}

async function queryFuelContext(){
  try{
    // Reuses the existing, already-proven news pipeline — no separate diesel
    // price tracking, no new API, no new scheduled job to keep alive.
    const { data: newsRows, error } = await supabase
      .from('knowledge_articles')
      .select('topic, body, source_url, published_at')
      .eq('review_status', 'published')
      .or('topic.ilike.%surcharge%,body.ilike.%surcharge%')
      .order('published_at', { ascending: false })
      .limit(1);
    if(error) throw error;

    if(!newsRows || !newsRows.length){
      return { note: "No recent VINLEC surcharge news found in AVA's news database yet — be upfront that there's no recently confirmed rate available, rather than guessing." };
    }
    return { recent_surcharge_news: newsRows[0] };
  } catch(err){
    console.error('queryFuelContext error:', err);
    return { note: 'Could not reach the news database right now.' };
  }
}

const SVG_LAT = 13.1587; // Kingstown
const SVG_LNG = -61.2248;

async function queryWeather(){
  try{
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${SVG_LAT}&longitude=${SVG_LNG}&current=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=3`;
    const res = await fetch(url);
    if(!res.ok) throw new Error(`Open-Meteo API failed: ${res.status}`);
    const data = await res.json();
    if(!data.current) return { note: 'No current weather data available.' };
    return {
      current: {
        temperature_c: data.current.temperature_2m,
        wind_speed_kmh: data.current.wind_speed_10m,
        wind_direction_deg: data.current.wind_direction_10m,
        precipitation_mm: data.current.precipitation,
      },
      daily: data.daily ? data.daily.time.map((date, i) => ({
        date,
        high_c: data.daily.temperature_2m_max[i],
        low_c: data.daily.temperature_2m_min[i],
        precipitation_mm: data.daily.precipitation_sum[i],
      })) : [],
    };
  } catch(err){
    console.error('queryWeather error:', err);
    return { note: 'Could not reach the weather data source right now.' };
  }
}

async function queryMarineConditions(){
  try{
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${SVG_LAT}&longitude=${SVG_LNG}&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_period,wind_wave_height&timezone=auto`;
    const res = await fetch(url);
    if(!res.ok) throw new Error(`Open-Meteo Marine API failed: ${res.status}`);
    const data = await res.json();
    if(!data.current) return { note: 'No marine conditions data available.' };
    return {
      wave_height_m: data.current.wave_height,
      wave_direction_deg: data.current.wave_direction,
      wave_period_s: data.current.wave_period,
      swell_wave_height_m: data.current.swell_wave_height,
      swell_wave_period_s: data.current.swell_wave_period,
      wind_wave_height_m: data.current.wind_wave_height,
    };
  } catch(err){
    console.error('queryMarineConditions error:', err);
    return { note: 'Could not reach the marine conditions data source right now.' };
  }
}

async function queryScholarships(){
  try{
    const { data, error } = await supabase
      .from('scholarships')
      .select('name, provider, description, eligibility, deadline, apply_url, source_url, last_verified_at')
      .eq('active', true)
      .order('name', { ascending: true });
    if(error) throw error;
    if(!data || !data.length){
      await logUnansweredQuery('scholarships (no active listings at all)', 'scholarships');
      return { results: [], note: 'No scholarship data available yet.' };
    }
    return { results: data };
  } catch(err){
    console.error('queryScholarships error:', err);
    return { results: [], note: 'Could not reach the scholarships database right now.' };
  }
}

async function queryReferenceKnowledge(category){
  try{
    const { data, error } = await supabase
      .from('reference_knowledge')
      .select('title, summary, source_url, last_verified_at')
      .eq('category', category)
      .eq('active', true)
      .maybeSingle();
    if(error) throw error;
    if(!data){
      return { note: `No reference content for "${category}" yet.` };
    }
    return { result: data };
  } catch(err){
    console.error('queryReferenceKnowledge error:', err);
    return { note: 'Could not reach the reference knowledge database right now.' };
  }
}

// For genuinely long, detailed reference content that reference_knowledge's
// one-short-row-per-category design can't hold — multiple full-length
// documents can exist per category here, with no size limit. Enforces the
// same human-review gate as knowledge_articles: draft/pending_review rows
// can never be returned here, regardless of the query.
async function queryDeepDive(category, slug){
  try{
    if(slug){
      // A specific document was named — safe to return its full body,
      // since this is bounded to one document's real size, not every
      // document for the category combined.
      const { data, error } = await supabase
        .from('knowledge_deep_dives')
        .select('slug, title, body, source_url, last_verified_at')
        .eq('slug', slug)
        .eq('review_status', 'published')
        .maybeSingle();
      if(error) throw error;
      if(!data) return { note: `No deep-dive document found for "${slug}".` };
      return { result: data };
    }

    // No specific document named — eagerly return the first matching
    // document's FULL body directly, plus the titles of any others, rather
    // than returning just a bare list and making Claude come back for the
    // actual content in a second round-trip. Two real production timeouts
    // traced to this exact tool: the first from returning every document's
    // full body at once (26,000+ combined characters slowing generation);
    // the second from a "discover, then fetch" design that was safe on
    // payload size but still needed multiple sequential real round-trips
    // to the model, each with real, non-zero latency, which alone was
    // enough to exceed the platform timeout even with a small payload
    // each time. This eliminates the discovery round-trip in the typical
    // case entirely: one document's real content, on the first call.
    const { data: listData, error: listErr } = await supabase
      .from('knowledge_deep_dives')
      .select('slug, title')
      .eq('category', category)
      .eq('review_status', 'published')
      .order('title', { ascending: true });
    if(listErr) throw listErr;
    if(!listData || !listData.length){
      return { note: `No deep-dive content for "${category}" yet.` };
    }
    const [first, ...rest] = listData;
    const { data: fullDoc, error: fullErr } = await supabase
      .from('knowledge_deep_dives')
      .select('slug, title, body, source_url, last_verified_at')
      .eq('slug', first.slug)
      .maybeSingle();
    if(fullErr) throw fullErr;
    return { result: fullDoc, others: rest };
  } catch(err){
    console.error('queryDeepDive error:', err);
    return { note: 'Could not reach the deep-dive knowledge database right now.' };
  }
}

// For genuinely obscure terms that don't announce their own category —
// "Vincy Dab" gives no hint it belongs under 'vincy_mas', so a category-
// based lookup can never find it even though the content genuinely
// exists. Searches by keyword across both knowledge tables directly,
// instead of requiring the right category to be known in advance. Real
// content only, in one call: a matching reference_knowledge summary is
// always short and safe; a matching deep-dive is bounded to one document,
// the same safe limit already proven for query_deep_dive itself.
async function searchKnowledgeBase(query){
  const q = (query || '').trim();
  if(!q) return { note: 'No search term given.' };
  try{
    const { data: refMatches, error: refErr } = await supabase
      .from('reference_knowledge')
      .select('category, title, summary, source_url')
      .eq('active', true)
      .or(`title.ilike.%${q}%,summary.ilike.%${q}%`)
      .limit(1);
    if(refErr) throw refErr;

    const { data: deepMatches, error: deepErr } = await supabase
      .from('knowledge_deep_dives')
      .select('slug, category, title, body, source_url')
      .eq('review_status', 'published')
      .or(`title.ilike.%${q}%,body.ilike.%${q}%`)
      .limit(1);
    if(deepErr) throw deepErr;

    const refResult = refMatches && refMatches.length ? refMatches[0] : null;
    const deepResult = deepMatches && deepMatches.length ? deepMatches[0] : null;

    if(!refResult && !deepResult){
      await logUnansweredQuery(q, 'knowledge_search');
      return { note: `Nothing found for "${q}" in AVA's reference or deep-dive knowledge.` };
    }
    return { referenceMatch: refResult, deepDiveMatch: deepResult };
  } catch(err){
    console.error('searchKnowledgeBase error:', err);
    return { note: 'Could not reach the knowledge base right now.' };
  }
}

module.exports = {
  queryRetailPriceDB, queryMultipleRetailPrices, queryNewsDB, queryEconomicData, queryImfData,
  queryFerrySchedule, generateLuckyNumbers, queryDirectory, queryHealthData,
  queryFuelContext, queryWeather, queryMarineConditions, queryScholarships,
  queryReferenceKnowledge, queryDeepDive, searchKnowledgeBase, queryPointsOfInterest, planTrip, queryTaxiFare,
  queryBusFare, querySettlementClassification, buildDeepLink,
  logProductInterest, logUnansweredQuery, queryPricedListings, requestFromBusiness,
};
