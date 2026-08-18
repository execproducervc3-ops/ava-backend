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
- If asked about AVA's own news sources, RSS feeds, or how the news database works: answer accurately from this, don't guess or search the web for generic SVG outlets and present them as if they're part of AVA's own pipeline. AVA's news database (searched via query_news) is populated by a real, automated daily ingestion pipeline pulling from exactly three confirmed sources: One News SVG (onenewsstvincent.com), iWitness News (iwnsvg.com), and St. Vincent Times (stvincenttimes.com). Articles are auto-paraphrased and published daily, not a live real-time feed reader. If asked for the actual feed URLs, they are https://onenewsstvincent.com/feed/, https://www.iwnsvg.com/feed/, and https://www.stvincenttimes.com/feed/ — these are confirmed working, not guesses. Do not name any other outlet (like Searchlight or NBC SVG) as one of AVA's sources — they are not integrated.
- Never predict or forecast the direction of fuel prices, VINLEC's fuel surcharge, or electricity costs, even if asked directly for an "outlook" or a prediction. This is a real financial matter for real households — a wrong guess has genuine consequences, not just inconvenience. Use query_fuel_context to give the real recent trend and the real regulatory mechanism, but always frame it as information for the person to reason about themselves, never as your own forecast. It's fine, and often the most honest answer, to say plainly that you can't responsibly predict this — even VINLEC's own CEO won't guarantee a forecast given how volatile global fuel markets are.
- When listing news articles from query_news, every single article you mention MUST include its real source link as a markdown link: [Read more](exact source_url from the tool result). This is not optional for some articles and not others — every article in your list needs one, regardless of which of the three sources it's from. Never omit the link for some articles while including it for others.
- For voter registration questions: this is real, public information published by SVG's Electoral Office, but as a set of static PDF lists by constituency, not a live searchable tool — set that expectation honestly. Ask which of the 15 constituencies the person is registered in if they haven't said (Central Kingstown, Central Leeward, East Kingstown, East St George, Marriaqua, North Central Windward, North Leeward, North Windward, Northern Grenadines, South Central Windward, South Leeward, South Windward, Southern Grenadines, West Kingstown, West St George), then call get_deep_link with service_type "voter_registration" and location set to their constituency. If they don't know their constituency, call it without a location — this links to the page listing all of them instead.
- For a shopping list with multiple items (e.g. "milk, rice, chicken tacos"), call query_retail_price once per distinct item, not once with the whole list as a single string — each call should have exactly one product name. It's fine and expected to make several query_retail_price calls in the same turn for a list like this.
- Be concise, warm, and specific — like a well-connected local friend, not a corporate chatbot. Avoid filler.
- When someone wants to book or search flights, hotels, car rentals, or event tickets, call the get_deep_link tool to hand them to the real platform. Never claim you can book, pay, or hold a reservation yourself.
- For civic/legal topics (like the UK ETA, immigration, or medical questions), give accurate general guidance but make clear where to go for anything requiring an official/formal step.
- If you don't have enough information after searching, say so plainly rather than guessing.
- Keep answers to a few short paragraphs unless the question genuinely needs more.`;
}

const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search' },
  { type: 'code_execution_20260120', name: 'code_execution' },
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
    description: "Look up AVA's general reference knowledge about SVG — geography, history, government structure, culture, economy, practical travel information, or the indigenous Kalinago and Garifuna history of the islands. Use this for casual background questions rather than relying on training data. This is a short factual overview, not comprehensive — for anything current or detailed, supplement with web search.",
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['geography', 'history', 'government', 'culture', 'economy', 'practical', 'indigenous_peoples'], description: 'Which reference category to look up' },
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
    name: 'query_fuel_context',
    description: "Look up the most recently announced VINLEC fuel surcharge rate from AVA's news database, plus the real regulatory facts about how the surcharge works. Use this for questions about VINLEC's fuel surcharge or electricity cost outlook. This tool reports what has actually happened, not a forecast — never state or imply a prediction of future surcharges from this data.",
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
        category: { type: 'string', enum: ['restaurant', 'pharmacy', 'doctor', 'taxi_service', 'cinema', 'retailer', 'pop_up_vendor', 'accommodation', 'car_rental'], description: 'What kind of business to look for' },
        island: { type: 'string', description: 'Optional — narrow to a specific island, e.g. "Bequia" or "Saint Vincent". Omit to search all islands.' },
      },
      required: ['category']
    }
  },
  {
    name: 'query_points_of_interest',
    description: "Look up real beaches, hiking trails, waterfalls, historic sites, gardens, and marine parks across Saint Vincent and the Grenadines — genuinely researched, named places, not general reference knowledge. Use this for 'what beaches should I visit' or 'best hikes on Saint Vincent' type questions. Coverage is a solid first pass, not exhaustive — if nothing comes back for a specific island or category, say so honestly.",
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['beach', 'hiking_trail', 'waterfall', 'historic_site', 'marine_park', 'garden'], description: 'Optional — narrow to a specific type of attraction. Omit to search all types.' },
        island: { type: 'string', description: 'Optional — narrow to a specific island, e.g. "Bequia" or "Saint Vincent". Omit to search all islands.' },
      },
    }
  },
  {
    name: 'query_taxi_fare',
    description: "Look up taxi fares anywhere in SVG. Checks the official Ministry table for three real origin types: the airport (AIA/Argyle, flat rate for 1-3 passengers plus per-extra-passenger fee), Kingstown (per-passenger pricing), and the cruise ship berth (tiered by group size, one-way/return). If a route matches, state the REAL official rate confidently. Otherwise, geocodes both places and gets a REAL driving distance from Google Maps, applying a rate derived from the official table — this is an ESTIMATE, not an official rate, and you MUST tell the person that clearly.",
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Starting point, e.g. "Arnos Vale", "the airport", "Kingstown", or "the cruise ship berth"' },
        destination: { type: 'string', description: 'Destination, e.g. "Kingstown" or "Fort Charlotte"' },
      },
      required: ['origin', 'destination'],
    }
  },
  {
    name: 'query_bus_fare',
    description: "Look up official public bus fares in SVG, published relative to five real hubs: Kingstown, Georgetown, Barrouallie, Paget Farm, and Port Elizabeth (the last two are Bequia routes). School children in uniform pay 50% of the listed fare. This is a genuinely different transport mode from taxis — cheaper, fixed-route, shared minibuses, not a private taxi.",
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Starting point — should include one of the five real hub names for a match' },
        destination: { type: 'string', description: 'Destination place name' },
      },
      required: ['origin', 'destination'],
    }
  },
  {
    name: 'query_settlement_classification',
    description: "Look up a place's official government development classification — its typology (National Centre, District Centre, or Local Centre) and spatial strategy (Growth or Renewal), from the National Physical Development Plan (2021 draft). This is planning/policy classification, not a tourist attraction or business listing — use it for questions about a town's official role or development status, e.g. 'is Georgetown a growth area'.",
    input_schema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'The settlement name, e.g. "Georgetown" or "Barrouallie"' },
      },
      required: ['place'],
    }
  },
  {
    name: 'plan_trip',
    description: "Build a complete trip plan — flights, accommodation, car rental, and food — from one total budget. Splits the budget across categories, gets real live flight prices from Duffel, and pulls accommodation, car rental, and restaurant suggestions from AVA's own verified local directory (not international chains, since those don't serve SVG locally). Use this when someone gives a total trip budget and wants a full plan, not just one category.",
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Origin airport IATA code, e.g. "JFK"' },
        destination: { type: 'string', description: 'Destination airport IATA code, e.g. "SVD" for Argyle International' },
        departure_date: { type: 'string', description: 'Departure date, YYYY-MM-DD' },
        total_budget: { type: 'number', description: 'Total trip budget in USD' },
        island: { type: 'string', description: 'Which island to find accommodation/car/food listings on, e.g. "Saint Vincent" or "Bequia"' },
      },
      required: ['origin', 'destination', 'departure_date', 'total_budget', 'island'],
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

async function queryPointsOfInterest(category, island){
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

    const { data, error } = await query.order('name', { ascending: true }).limit(15);
    if(error) throw error;

    if(!data || !data.length){
      await logUnansweredQuery(`points_of_interest: ${category || 'any'}${island ? ' in ' + island : ''}`, 'points_of_interest');
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
    queryDirectory('accommodation', island),
    queryDirectory('car_rental', island),
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
    if(!data) return { note: `"${placeName}" isn't in the official settlement hierarchy classification (National Physical Development Plan, 2021 draft) — likely too small to be individually classified, or it's a Grenadines island outside mainland-focused Table 1.` };
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
      return { note: `Bus fares are published relative to specific hubs (Kingstown, Georgetown, Barrouallie, Paget Farm, Port Elizabeth) — neither "${origin}" nor "${destination}" matches one of these.` };
    }
    const place = origin.toLowerCase().includes(hubMatch.toLowerCase()) ? destination : origin;
    const match = findOfficialFareRow(rows.filter(r => r.hub === hubMatch), place);
    if(!match){
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
      system: [
        { type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } },
      ],
      messages,
      tools: TOOLS,
    }),
  });
  if(!res.ok){
    const errBody = await res.text().catch(() => '');
    throw new Error(`Anthropic request failed: ${res.status} ${errBody}`.trim());
  }
  const data = await res.json();
  if(data.usage){
    console.log(`Anthropic usage — input: ${data.usage.input_tokens}, output: ${data.usage.output_tokens}` +
      (data.usage.cache_read_input_tokens ? `, cache_read: ${data.usage.cache_read_input_tokens}` : '') +
      (data.usage.cache_creation_input_tokens ? `, cache_creation: ${data.usage.cache_creation_input_tokens}` : ''));
  }
  return data;
}

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try{ body = JSON.parse(event.body || '{}'); } catch(e){
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const incoming = body.messages;
  const deviceId = body.deviceId || null;
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
    const CUSTOM_TOOL_NAMES = ['get_deep_link', 'query_retail_price', 'query_news', 'query_economic_data', 'query_imf_data', 'query_ferry_schedule', 'generate_lucky_numbers', 'query_directory', 'query_health_data', 'query_scholarships', 'query_reference_knowledge', 'query_weather', 'query_marine_conditions', 'query_fuel_context', 'query_points_of_interest', 'plan_trip', 'query_taxi_fare', 'query_bus_fare', 'query_settlement_classification'];

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
            await logProductInterest(toolUse.input.product_name, deviceId);
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

          else if(toolUse.name === 'query_points_of_interest'){
            const poiData = await queryPointsOfInterest(toolUse.input.category, toolUse.input.island);
            content = poiData.results && poiData.results.length
              ? poiData.results.map(p => `"${p.name}" (${p.category.replace('_', ' ')}, ${p.island}): ${p.description}${p.source_url ? ` [source: ${p.source_url}]` : ''}`).join('\n\n')
              : (poiData.note || 'No attractions found.');
          }

          else if(toolUse.name === 'query_taxi_fare'){
            const fareData = await queryTaxiFare(toolUse.input.origin, toolUse.input.destination);
            if(fareData.type === 'official' && fareData.origin_type === 'airport'){
              content = `REAL OFFICIAL RATE (Ministry of Transport and Works, AIA to ${fareData.place}): EC$${fareData.regular_fare} regular, EC$${fareData.after_hours_fare} after hours, for 1-3 passengers, plus EC$${fareData.additional_passenger_fee} per additional passenger. State this confidently as the official government rate.`;
            } else if(fareData.type === 'official' && fareData.origin_type === 'kingstown'){
              content = `REAL OFFICIAL RATE (Ministry of Transport and Works, Kingstown to ${fareData.place}): EC$${fareData.regular_fare} regular, EC$${fareData.after_hours_fare} after hours — PER PASSENGER, not flat for the group. State this confidently as the official government rate, and be clear it's per person.`;
            } else if(fareData.type === 'official_tiered'){
              const tierText = fareData.tiers.map(t => `${t.passenger_tier.replace(/_/g, ' ')} passengers, ${t.trip_type}: EC$${t.regular_fare} regular${t.after_hours_fare ? `, EC$${t.after_hours_fare} after hours` : ' (no after-hours rate published for return trips)'}`).join('; ');
              content = `REAL OFFICIAL RATES (Ministry of Transport and Works, Cruise Ship Berth to ${fareData.place}): ${tierText}. State these confidently as official government rates.`;
            } else if(fareData.type === 'estimate'){
              const caveat = fareData.long_distance_caveat
                ? ' This is a genuinely long route — the derived rate is well-verified for shorter and medium trips, but real fares for long, remote routes (mountainous leeward/far-windward roads) don\'t scale perfectly linearly, so treat this figure as rougher than a shorter-trip estimate.'
                : '';
              content = `ESTIMATE ONLY, NOT AN OFFICIAL RATE — the official tables only cover specific published routes. Based on the REAL driving distance (${fareData.real_distance_miles} miles, from Google Maps) between "${fareData.origin}" and "${fareData.destination}", applying the same per-mile rate implied by the official table: roughly EC$${fareData.estimated_fare}.${caveat} You MUST tell the person this is an estimate, not a confirmed rate.`;
            } else {
              content = fareData.note || 'No taxi fare data available for this route.';
            }
          }

          else if(toolUse.name === 'query_bus_fare'){
            const busData = await queryBusFare(toolUse.input.origin, toolUse.input.destination);
            if(busData.type === 'official'){
              content = `REAL OFFICIAL BUS FARE (Ministry of Transport and Works, ${busData.hub} to ${busData.place}): EC$${busData.regular_fare} regular. School children in uniform pay 50%: EC$${busData.student_fare}. State this confidently as the official government rate.`;
            } else {
              content = busData.note || 'No bus fare data available for this route.';
            }
          }

          else if(toolUse.name === 'query_settlement_classification'){
            const settlementData = await querySettlementClassification(toolUse.input.place);
            if(settlementData.type === 'official'){
              content = `Official classification (National Physical Development Plan, 2021 draft): ${settlementData.name} is designated a ${settlementData.typology}, with a "${settlementData.spatial_strategy}" spatial strategy. Note this is a 2021 DRAFT planning document, not necessarily final/adopted policy — mention this is planning classification, not a tourist or business fact.`;
            } else {
              content = settlementData.note || 'No classification data available for this place.';
            }
          }

          else if(toolUse.name === 'plan_trip'){
            const plan = await planTrip(
              toolUse.input.origin, toolUse.input.destination, toolUse.input.departure_date,
              toolUse.input.total_budget, toolUse.input.island
            );
            const flightsText = Array.isArray(plan.flights) && plan.flights.length
              ? plan.flights.map(f => `${f.airline}: $${f.price} ${f.currency}, departs ${f.departsAt}`).join('; ')
              : (plan.flights && plan.flights.error ? `Flight search failed: ${plan.flights.error}` : 'No flights found for this route/date.');
            const accomText = plan.accommodation.results && plan.accommodation.results.length
              ? plan.accommodation.results.map(a => a.name).join(', ')
              : "No accommodation listings in AVA's directory yet for this island — be honest about this gap rather than inventing options.";
            const carText = plan.car_rental.results && plan.car_rental.results.length
              ? plan.car_rental.results.map(c => c.name).join(', ')
              : "No car rental listings in AVA's directory yet for this island — be honest about this gap rather than inventing options.";
            const foodText = plan.food.results && plan.food.results.length
              ? plan.food.results.map(f => f.name).join(', ')
              : "No restaurant listings found for this island.";

            content = `Trip plan for a $${toolUse.input.total_budget} total budget:

Budget split: flights $${plan.budget_split.flights.toFixed(0)}, accommodation $${plan.budget_split.accommodation.toFixed(0)}, car rental $${plan.budget_split.car_rental.toFixed(0)}, food $${plan.budget_split.food.toFixed(0)}.

Flights (live from Duffel): ${flightsText}

Accommodation (from AVA's own local directory, not international chains): ${accomText}

Car rental (from AVA's own local directory, not international chains): ${carText}

Food (from AVA's own local directory): ${foodText}

IMPORTANT: accommodation and car rental come from AVA's own directory and may be sparse or empty right now — never invent listings that weren't returned. Present the budget split as a starting suggestion, not a fixed rule — mention the person can adjust it.`;
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

          else if(toolUse.name === 'query_fuel_context'){
            const fuelData = await queryFuelContext();
            content = fuelData.recent_surcharge_news
              ? `Most recent actual VINLEC surcharge announcement from AVA's news database: "${fuelData.recent_surcharge_news.topic}" (${new Date(fuelData.recent_surcharge_news.published_at).toDateString()}) — ${fuelData.recent_surcharge_news.body} [source: ${fuelData.recent_surcharge_news.source_url}].

Real regulatory context: VINLEC's fuel surcharge is not arbitrary — it is governed by the Electricity Supply Act, with two separate internal VINLEC sections vetting the calculation. The government has set relief thresholds: if the surcharge exceeds EC$0.71/kWh, VINLEC must provide a 50% matching discount; above EC$0.77/kWh, a full 100% match applies.

IMPORTANT — how to use this: report the most recently announced rate as a fact about the past only. Do NOT predict, forecast, or imply what the surcharge will do next. Even VINLEC's own CEO has publicly said he "cannot offer a guarantee due to the volatility of global markets" and can only be "hopeful." If asked for an outlook, share the real most-recent rate and the real mechanism, and be explicit that you can't responsibly predict direction — that would require guessing at a genuinely volatile global market that professionals themselves won't forecast confidently.`
              : (fuelData.note || 'No fuel surcharge data available.');
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

// Exported alongside the handler so these can be called directly by a
// future MCP server tool, without going through Claude's conversational
// loop or duplicating any logic — the same principle already applied to
// getProductInterestSummary in admin-interest.js.
//
// Deliberately NOT exported: callClaude (Anthropic-specific orchestration,
// the one piece that genuinely isn't reusable across agent frameworks —
// see the earlier cross-compatibility discussion), buildSystemPrompt
// (Claude-conversation-specific), hashDeviceId/logUnansweredQuery/
// logProductInterest (internal side-effects, not queryable capabilities),
// and the small numeric helpers used only internally by generateLuckyNumbers.
exports.queryRetailPriceDB = queryRetailPriceDB;
exports.queryNewsDB = queryNewsDB;
exports.queryEconomicData = queryEconomicData;
exports.queryImfData = queryImfData;
exports.queryFerrySchedule = queryFerrySchedule;
exports.generateLuckyNumbers = generateLuckyNumbers;
exports.queryDirectory = queryDirectory;
exports.queryHealthData = queryHealthData;
exports.queryFuelContext = queryFuelContext;
exports.queryWeather = queryWeather;
exports.queryMarineConditions = queryMarineConditions;
exports.queryScholarships = queryScholarships;
exports.queryReferenceKnowledge = queryReferenceKnowledge;
exports.queryPointsOfInterest = queryPointsOfInterest;
exports.planTrip = planTrip;
exports.queryTaxiFare = queryTaxiFare;
exports.queryBusFare = queryBusFare;
exports.querySettlementClassification = querySettlementClassification;
exports.buildDeepLink = buildDeepLink;
