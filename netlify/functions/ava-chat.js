const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function buildSystemPrompt(){
  const now = new Date();
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const todayName = dayNames[now.getUTCDay()];
  const todayISO = now.toISOString().slice(0, 10);

  return `You are AVA — "Ask Vincy Anything" — a warm, knowledgeable local concierge for daily life, tourism, and travel in Saint Vincent and the Grenadines (SVG). You are talking to residents, diaspora, and visitors.

Today's date is ${todayISO} (${todayName}). Use this to resolve relative date references like "tomorrow" or "this Saturday" into the correct day of the week before calling any tool that needs one.

Rules:
- Use web search for anything current or specific: prices, hours, events, news. Don't guess at facts that could be out of date.
- For questions about grocery, retail, or product prices at specific stores/retailers, use the query_retail_price tool first — it checks AVA's own database of prices submitted directly by real retailers. This data is early and limited (only a handful of retailers have submitted so far), so if it returns nothing or very little, say so honestly rather than presenting it as a complete market picture, and you may supplement with web search for general context.
- For ferry schedule questions, use the query_ferry_schedule tool. Compute the correct day_of_week (0=Sunday through 6=Saturday) from today's date and whatever relative term the person used. This data is real but limited to routes AVA has confirmed — if it comes back empty, say so honestly and pass along whatever contact info the tool provides rather than guessing at a time. Always mention that ferry schedules can change and it's worth confirming directly before travel, even when AVA has a confirmed time.
- For customs/import duty questions: SVG's VAT is 15% standard, 10% reduced (e.g. hotel sector), 0% zero-rated (this includes most computer/electronics equipment) — this was reduced from 16% as part of 2026 tax reforms, so use 15%, not any older figure you may recall. There is also a separate Customs Service Charge (CSC) of a few percent applied to most imports, on top of duty and VAT. Never calculate or state an exact duty amount yourself — rates vary by specific HS tariff code and this changes over time. Instead, give this general context, then call get_deep_link with service_type "customs_general" for ordinary goods or "customs_vehicle" for vehicles specifically (vehicles also have a separate environmental tax based on engine size for vehicles over 4 years old) to hand them to SVG Customs' own official calculator for the exact figure.
- For voter registration questions: this is real, public information published by SVG's Electoral Office, but as a set of static PDF lists by constituency, not a live searchable tool — set that expectation honestly. Ask which of the 15 constituencies the person is registered in if they haven't said (Central Kingstown, Central Leeward, East Kingstown, East St George, Marriaqua, North Central Windward, North Leeward, North Windward, Northern Grenadines, South Central Windward, South Leeward, South Windward, Southern Grenadines, West Kingstown, West St George), then call get_deep_link with service_type "voter_registration" and location set to their constituency. If they don't know their constituency, call it without a location — this links to the page listing all of them instead.
- For a shopping list with multiple items (e.g. "milk, rice, chicken tacos"), call query_retail_price once per distinct item, not once with the whole list as a single string — each call should have exactly one product name. It's fine and expected to make several query_retail_price calls in the same turn for a list like this.
- Be concise, warm, and specific — like a well-connected local friend, not a corporate chatbot. Avoid filler.
- When someone wants to book or search flights, hotels, car rentals, or event tickets, call the get_deep_link tool to hand them to the real platform. Never claim you can book, pay, or hold a reservation yourself.
- For civic/legal topics (like the UK ETA, immigration, or medical questions), give accurate general guidance but make clear where to go for anything requiring an official/formal step.
- If you don't have enough information after searching, say so plainly rather than guessing.
- Keep answers to a few short paragraphs unless the question genuinely needs more.`;
}

const TOOLS = [
  { type: 'web_search_20250305', name: 'web_search' },
  {
    name: 'get_deep_link',
    description: 'Generate a link to a real external platform for booking flights, hotels, car rentals, finding event tickets, calculating customs import duty, or checking voter registration. Use this instead of claiming you can book, calculate, or look something up yourself.',
    input_schema: {
      type: 'object',
      properties: {
        service_type: { type: 'string', enum: ['flights','hotels','cars','events','customs_general','customs_vehicle','voter_registration'] },
        origin: { type: 'string', description: 'For flights: departure city/airport' },
        destination: { type: 'string', description: 'For flights: arrival city/airport, defaults to SVG' },
        date: { type: 'string', description: 'For flights: travel date if known' },
        location: { type: 'string', description: 'For hotels/cars/events: location, defaults to SVG. For voter_registration: the person\'s constituency — ask them if not stated, since this determines which list to link to.' },
        checkin: { type: 'string' },
        checkout: { type: 'string' },
        query: { type: 'string', description: 'For events: what kind of event' },
      },
      required: ['service_type']
    }
  },
  {
    name: 'query_retail_price',
    description: "Look up real, retailer-submitted prices for a specific product in AVA's own database (e.g. groceries, food items). Returns every current offer, cheapest first, with retailer name and location. Use this before web search for product/price questions.",
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'The product to look up, e.g. "chicken tacos" or "rice"' },
      },
      required: ['product_name']
    }
  },
  {
    name: 'query_news',
    description: "Search AVA's own database of published local SVG news articles. Use this before web search for questions about recent local news, government announcements, or current happenings in SVG — this is curated, human-reviewed content specific to SVG, more reliable than a general web search for local news. For a specific subject, pass that as the topic. For a general 'what's the latest news' style question, pass a general term like 'latest' — this returns the most recent published articles.",
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'What to search for, e.g. "youth council" or "Vincy Mas" — or "latest" for a general news request' },
      },
      required: ['topic']
    }
  },
  {
    name: 'query_economic_data',
    description: "Look up real, current economic and governance indicators for Saint Vincent and the Grenadines from the World Bank's public database — GDP, inflation, unemployment, population, remittances, tourism receipts, plus governance quality measures (corruption control, government effectiveness, political stability, regulatory quality, rule of law, voice and accountability). Use this for any question about SVG's economy or governance rather than relying on training data, which may be outdated.",
    input_schema: {
      type: 'object',
      properties: {
        indicator: { type: 'string', enum: ['gdp', 'gdp growth', 'inflation', 'unemployment', 'population', 'remittances', 'tourism', 'labor force participation', 'corruption control', 'government effectiveness', 'political stability', 'regulatory quality', 'rule of law', 'voice and accountability'], description: 'Which economic or governance indicator to look up' },
      },
      required: ['indicator']
    }
  },
  {
    name: 'query_imf_data',
    description: "Look up IMF World Economic Outlook data for Saint Vincent and the Grenadines — GDP growth forecasts, inflation, government debt, current account balance, fiscal balance. Complements query_economic_data (World Bank) with IMF's own forward-looking forecasts and fiscal/government indicators World Bank doesn't cover. Note in your answer that recent/future years in this data are often IMF forecasts, not confirmed actuals.",
    input_schema: {
      type: 'object',
      properties: {
        indicator: { type: 'string', enum: ['gdp growth', 'inflation', 'government debt', 'current account', 'fiscal balance'], description: 'Which IMF indicator to look up' },
      },
      required: ['indicator']
    }
  },
  {
    name: 'query_ferry_schedule',
    description: "Look up real ferry sailing times between Kingstown, St. Vincent and a Grenadine island. Coverage is limited to routes AVA has confirmed — if nothing comes back, say so honestly rather than guessing at a time, since giving a wrong ferry time could genuinely strand someone.",
    input_schema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Destination island, e.g. "Bequia", "Canouan", "Union Island"' },
        day_of_week: { type: 'integer', description: 'Day to check: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday. Compute this from the current date given in the system prompt and the relative term the person used.' },
      },
      required: ['destination', 'day_of_week']
    }
  },
  {
    name: 'query_reference_knowledge',
    description: "Look up AVA's general reference knowledge about SVG — geography, history, government structure, culture, or economy. Use this for casual background questions rather than relying on training data. This is a short factual overview, not comprehensive — for anything current or detailed, supplement with web search.",
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['geography', 'history', 'government', 'culture', 'economy'], description: 'Which reference category to look up' },
      },
      required: ['category']
    }
  },
  {
    name: 'query_scholarships',
    description: "Look up regional scholarships, funding, and grant opportunities for Vincentians that AVA tracks — Commonwealth, Chevening, Taiwan, CDB, and SVG National Scholarships. This is a fixed, individually-verified list, not an exhaustive search — if it comes back empty or the person asks about something not on this list, say so honestly and suggest a web search for that specific program.",
    input_schema: {
      type: 'object',
      properties: {},
    }
  },
  {
    name: 'query_health_data',
    description: "Look up real public health indicators for Saint Vincent and the Grenadines from the World Health Organization's Global Health Observatory. Use this for questions about life expectancy or other health statistics rather than relying on training data, which may be outdated.",
    input_schema: {
      type: 'object',
      properties: {
        indicator: { type: 'string', enum: ['life expectancy'], description: 'Which WHO health indicator to look up' },
      },
      required: ['indicator']
    }
  },
  {
    name: 'query_weather',
    description: "Look up real current weather and short-term forecast for Saint Vincent and the Grenadines (Kingstown area). Use this for general weather questions rather than relying on training data.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'query_marine_conditions',
    description: "Look up real marine/sailing conditions for SVG waters — wave height, swell height and period, wind waves. Use this for questions about sailing, boating, or ocean conditions, not general weather. A longer swell period generally means more organized, easier sailing conditions; a short period means choppier seas.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'generate_lucky_numbers',
    description: "Generate a set of random lucky numbers for one of SVG's National Lottery games (Super 6, Lotto, 3D, Play 4), matching that game's real format. This is purely for fun/entertainment — random numbers, not a prediction or a real draw result. Never present these as real winning numbers.",
    input_schema: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: ['super6', 'lotto', '3d', 'play4'], description: 'Which lottery game to generate numbers for' },
      },
      required: ['game']
    }
  },
  {
    name: 'query_directory',
    description: "Search AVA's own directory of real SVG businesses — restaurants, pharmacies, doctors, taxi services — sourced from Google Places and kept current. Use this before web search for 'where can I find X' or 'is there a Y near me' questions. Coverage is limited to what's been ingested so far (mainly Saint Vincent, Bequia, Union Island) — if nothing comes back, say so honestly rather than guessing at a business that might exist.",
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['restaurant', 'pharmacy', 'doctor', 'taxi_service', 'cinema', 'retailer', 'pop_up_vendor'], description: 'What kind of business to look for' },
        island: { type: 'string', description: 'Optional — narrow to a specific island, e.g. "Bequia" or "Saint Vincent". Omit to search all islands.' },
      },
      required: ['category']
    }
  }
];

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
      .select('item_name, price, unit, standard_unit_type, price_per_standard_unit, photo_url, listing_id, created_at')
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

    // Fall back to "most recent published" for generic/browse-style asks, and
    // also for a specific search that came up empty — a graceful degrade
    // rather than a dead end. specificSearchFailed still gets logged below
    // even though the user gets a useful fallback answer instead of nothing —
    // the gap is real even when the UX papers over it gracefully.
    if(isBrowseRequest || !data || !data.length){
      ({ data, error } = await supabase
        .from('knowledge_articles')
        .select('topic, body, source_url, published_at')
        .eq('review_status', 'published')
        .order('published_at', { ascending: false })
        .limit(5));
      if(error) throw error;
    }

    if(specificSearchFailed) await logUnansweredQuery(topic.trim(), 'news');

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

async function queryDirectory(category, island){
  try{
    let query = supabase
      .from('directory_listings')
      .select('name, address, island, phone, category')
      .eq('category', category)
      .eq('status', 'active');

    if(island && island.trim()){
      query = query.ilike('island', `%${island.trim()}%`);
    }

    const { data, error } = await query.order('name', { ascending: true }).limit(10);
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

async function callClaude(messages){
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: buildSystemPrompt(),
      messages,
      tools: TOOLS,
    }),
  });
  if(!res.ok){
    const errBody = await res.text().catch(() => '');
    throw new Error(`Anthropic request failed: ${res.status} ${errBody}`.trim());
  }
  return res.json();
}

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try{ body = JSON.parse(event.body || '{}'); } catch(e){
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const incoming = body.messages;
  if(!Array.isArray(incoming) || !incoming.length){
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'messages array is required' }) };
  }

  try{
    let messages = incoming.slice();
    let finalText = '';
    let linkCard = null;
    let retailResults = [];
    let newsResults = null;
    let ferryResults = null;
    let luckyNumbers = null;
    let directoryResults = null;
    let loops = 0;
    const CUSTOM_TOOL_NAMES = ['get_deep_link', 'query_retail_price', 'query_news', 'query_economic_data', 'query_imf_data', 'query_ferry_schedule', 'generate_lucky_numbers', 'query_directory', 'query_health_data', 'query_scholarships', 'query_reference_knowledge', 'query_weather', 'query_marine_conditions'];

    while(loops < 4){
      loops++;
      const data = await callClaude(messages);
      const toolUseBlocks = (data.content || []).filter(b => b.type === 'tool_use' && CUSTOM_TOOL_NAMES.includes(b.name));
      const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n');
      if(textBlocks) finalText += (finalText ? '\n\n' : '') + textBlocks;

      if(toolUseBlocks.length){
        // Every tool_use block in this turn MUST get a matching tool_result in the
        // next message — Anthropic's API rejects the request otherwise. Process
        // all of them, not just the first, even if Claude asked for several at once.
        const toolResults = [];
        for(const toolUse of toolUseBlocks){
          let content = 'Unknown tool.';

          if(toolUse.name === 'get_deep_link'){
            const link = buildDeepLink(toolUse.input.service_type, toolUse.input);
            if(link) linkCard = link;
            content = link ? `Link generated: ${link.url}` : 'Could not generate a link for that service type.';
          }

          else if(toolUse.name === 'query_news'){
            const newsData = await queryNewsDB(toolUse.input.topic);
            if(newsData.results && newsData.results.length) newsResults = newsData.results;
            content = newsData.results && newsData.results.length
              ? newsData.results.map(a => `"${a.topic}" (${a.published_at ? new Date(a.published_at).toDateString() : 'undated'}): ${a.body} [source: ${a.source_url}]`).join('\n\n')
              : (newsData.note || 'No published articles found on that topic.');
          }

          else if(toolUse.name === 'query_retail_price'){
            const priceData = await queryRetailPriceDB(toolUse.input.product_name);
            retailResults.push({
              product: toolUse.input.product_name,
              results: priceData.results || [],
              note: (!priceData.results || !priceData.results.length) ? (priceData.note || 'No results found.') : null,
            });
            content = priceData.results && priceData.results.length
              ? `Found ${priceData.results.length} offer(s), cheapest first (normalized by price per lb or per gallon where the unit could be parsed, so this correctly compares different package sizes — e.g. a 10kg bag vs a 5lb bag): ` + priceData.results.map(r => {
                  const loc = [r.parish, r.island].filter(Boolean).join(', ');
                  const normalized = r.price_per_standard_unit ? ` [≈ $${r.price_per_standard_unit}/${r.standard_unit_type === 'weight_lb' ? 'lb' : 'gallon'}]` : '';
                  return `${r.retailer}: $${r.price}${r.unit ? '/' + r.unit : ''}${normalized}${loc ? ` (${loc})` : ''}${r.phone ? `, phone ${r.phone}` : ''}`;
                }).join('; ')
              : (priceData.note || 'No results found in the database for that product.');
          }

          else if(toolUse.name === 'query_economic_data'){
            const econData = await queryEconomicData(toolUse.input.indicator);
            content = econData.values && econData.values.length
              ? `${econData.indicator} (source: World Bank): ` + econData.values.map(v => `${v.year}: ${v.value}`).join(', ')
              : (econData.note || 'No data available for that indicator.');
          }

          else if(toolUse.name === 'query_imf_data'){
            const imfData = await queryImfData(toolUse.input.indicator);
            content = imfData.values && imfData.values.length
              ? `${imfData.indicator} (source: IMF World Economic Outlook): ` + imfData.values.map(v => `${v.year}: ${v.value}`).join(', ') + '. Note: recent and future years in IMF WEO data are often forecasts, not confirmed actuals — say so if relevant.'
              : (imfData.note || 'No data available for that indicator.');
          }

          else if(toolUse.name === 'query_ferry_schedule'){
            const ferryData = await queryFerrySchedule(toolUse.input.destination, toolUse.input.day_of_week);
            if(ferryData.results && ferryData.results.length) ferryResults = ferryData.results;
            content = ferryData.results && ferryData.results.length
              ? `Sailings found: ` + ferryData.results.map(s => `${s.operator}: ${s.origin} → ${s.destination} at ${s.departure_time}${s.fare_economy ? `, $${s.fare_economy} EC` : ''}`).join('; ') + '. Remind the person schedules can change — worth confirming directly before travel.'
              : (ferryData.note || 'No ferry data available for that route.');
          }

          else if(toolUse.name === 'generate_lucky_numbers'){
            const lucky = generateLuckyNumbers(toolUse.input.game);
            if(lucky.note){
              content = lucky.note;
            } else if(lucky.game === '3D'){
              luckyNumbers = lucky;
              content = `3D: Big-D ${lucky.bigD}, Mid-D ${lucky.midD}, Little-D ${lucky.littleD}. Make clear these are random for-fun numbers, not a real draw result.`;
            } else if(lucky.game === 'Play 4'){
              luckyNumbers = lucky;
              content = `Play 4: ${lucky.digits.join(' ')}. Make clear these are random for-fun numbers, not a real draw result.`;
            } else {
              luckyNumbers = lucky;
              content = `${lucky.game}: ${lucky.numbers.join(', ')}${lucky.bonusBall ? `, Bonus Ball ${lucky.bonusBall}` : ''}, letter ${lucky.bonusLetter}. Make clear these are random for-fun numbers, not a real draw result.`;
            }
          }

          else if(toolUse.name === 'query_directory'){
            const dirData = await queryDirectory(toolUse.input.category, toolUse.input.island);
            if(dirData.results && dirData.results.length) directoryResults = dirData.results;
            content = dirData.results && dirData.results.length
              ? `Found ${dirData.results.length}: ` + dirData.results.map(d => `${d.name}${d.island ? ` (${d.island})` : ''}${d.phone ? `, ${d.phone}` : ''}`).join('; ')
              : (dirData.note || 'No listings found.');
          }

          else if(toolUse.name === 'query_health_data'){
            const healthData = await queryHealthData(toolUse.input.indicator);
            content = healthData.values && healthData.values.length
              ? `${healthData.indicator} (source: WHO Global Health Observatory): ` + healthData.values.map(v => `${v.year}: ${v.value}`).join(', ')
              : (healthData.note || 'No data available for that indicator.');
          }

          else if(toolUse.name === 'query_weather'){
            const weatherData = await queryWeather();
            content = weatherData.current
              ? `Current in Kingstown, SVG (source: Open-Meteo): ${weatherData.current.temperature_c}°C, wind ${weatherData.current.wind_speed_kmh} km/h from ${weatherData.current.wind_direction_deg}°, precipitation ${weatherData.current.precipitation_mm}mm. Next few days: ` + weatherData.daily.map(d => `${d.date}: ${d.low_c}-${d.high_c}°C, ${d.precipitation_mm}mm rain`).join('; ')
              : (weatherData.note || 'No weather data available.');
          }

          else if(toolUse.name === 'query_marine_conditions'){
            const marineData = await queryMarineConditions();
            content = marineData.wave_height_m !== undefined && marineData.wave_height_m !== null
              ? `Current marine conditions off SVG (source: Open-Meteo Marine, ICON Wave model): wave height ${marineData.wave_height_m}m from ${marineData.wave_direction_deg}°, wave period ${marineData.wave_period_s}s. Swell: ${marineData.swell_wave_height_m}m height, ${marineData.swell_wave_period_s}s period. Wind waves: ${marineData.wind_wave_height_m}m.`
              : (marineData.note || 'No marine conditions data available.');
          }

          else if(toolUse.name === 'query_scholarships'){
            const scholarshipData = await queryScholarships();
            content = scholarshipData.results && scholarshipData.results.length
              ? scholarshipData.results.map(s => {
                  const verified = s.last_verified_at ? new Date(s.last_verified_at).toDateString() : 'unknown date';
                  return `"${s.name}" (${s.provider || 'provider unknown'}): ${s.description || ''} Eligibility: ${s.eligibility || 'not specified'}. Deadline: ${s.deadline || 'not specified'}. Apply: ${s.apply_url || 'see source'}. [Last verified ${verified} — mention this date and suggest confirming directly before applying, since deadlines can change]`;
                }).join('\n\n')
              : (scholarshipData.note || 'No scholarship data available.');
          }

          else if(toolUse.name === 'query_reference_knowledge'){
            const refData = await queryReferenceKnowledge(toolUse.input.category);
            content = refData.result
              ? `${refData.result.title}: ${refData.result.summary} [Source: ${refData.result.source_url || 'unknown'}, last verified ${refData.result.last_verified_at ? new Date(refData.result.last_verified_at).toDateString() : 'unknown'}]`
              : (refData.note || 'No reference content available.');
          }

          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content });
        }

        messages = messages.concat([
          { role: 'assistant', content: data.content },
          { role: 'user', content: toolResults },
        ]);
        continue;
      }

      if(data.stop_reason === 'tool_use'){
        // a web_search call resolves within the same response chain server-side (Anthropic-hosted);
        // if we land here it means no further custom tool is pending — stop rather than loop forever.
        break;
      }
      break;
    }

    if(!finalText) finalText = "I couldn't quite work that one out — could you rephrase, or ask something more specific?";
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ text: finalText, linkCard, retailResults: retailResults.length ? retailResults : null, newsResults, ferryResults, luckyNumbers, directoryResults }) };
  } catch(err){
    console.error('ava-chat error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error: ' + err.message }) };
  }
};
