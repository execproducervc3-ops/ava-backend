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
- This applies just as much to "where can I find/buy X" or "who sells X" phrasing as it does to direct price questions — check query_retail_price for the specific product BEFORE falling back to query_directory or general web suggestions like Facebook Marketplace or generic hardware stores. AVA's own verified data is more useful than a generic pointer, and takes priority when it exists.
- For a short, product-name-like query (e.g. "rims", "rice", "phone charger"), always attempt a direct search first — query_retail_price and/or query_directory as relevant — rather than presenting a multiple-choice clarifying question. Only ask a clarifying question if the search genuinely comes back empty or too ambiguous to act on; don't ask one as a first response to a query that could just be searched directly.
- Always check whether you've already found something relevant earlier in this same conversation before answering as if starting fresh — if a specific product or retailer came up a few messages ago, use and mention that instead of giving generic advice that contradicts or ignores what you already found.
- Never invent subjective quality claims about a business — "unforgettable," "a hidden gem," "the best" — when there's no real data behind it. AVA has no review or rating data at all right now, so any such language is fabricated, not a genuine recommendation. Only ever describe something as a "top pick" or similar if query_directory explicitly marks it as a real, admin-curated top pick — and if so, use the real reason given, not your own invented one. Otherwise, stick to verifiable facts: name, location, contact, price if known.
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
    description: "Look up real, retailer-submitted prices for a specific product in AVA's own database (e.g. groceries, food items). Returns every current offer, cheapest first, with retailer name and location. Use this before web search for product/price questions. IMPORTANT: only use this for a SINGLE product. If someone asks about several products at once (a shopping list, 'find me the cheapest X, Y, and Z'), use query_multiple_retail_prices instead — calling this tool once per item is much slower and should be avoided.",
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'The product to look up, e.g. "chicken tacos" or "rice"' },
      },
      required: ['product_name']
    }
  },
  {
    name: 'query_multiple_retail_prices',
    description: "Look up real, retailer-submitted prices for SEVERAL products at once — use this whenever someone gives a shopping list or asks about more than one item together, instead of calling query_retail_price repeatedly. Runs all lookups in parallel internally, which is significantly faster than multiple separate calls and avoids request timeouts on longer lists.",
    input_schema: {
      type: 'object',
      properties: {
        product_names: { type: 'array', items: { type: 'string' }, description: 'The list of products to look up, e.g. ["rice", "sugar", "cooking oil"]' },
      },
      required: ['product_names']
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
    description: "Look up AVA's general reference knowledge about SVG — geography, history, government structure, culture, economy, practical travel information, music, motorsports, Vincy Mas carnival, or the indigenous Kalinago and Garifuna history of the islands. Use this for casual background questions rather than relying on training data. This is a short factual overview, not comprehensive — if the person genuinely wants real depth on a topic (e.g. Vincy Mas specifically), also try query_deep_dive for that category, since a full-length document may exist there. For anything current or not covered by either, supplement with web search.",
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['geography', 'history', 'government', 'culture', 'economy', 'practical', 'indigenous_peoples', 'music', 'motorsports', 'vincy_mas'], description: 'Which reference category to look up' },
      },
      required: ['category']
    }
  },
  {
    name: 'query_deep_dive',
    description: "Look up genuinely long-form, detailed reference documents AVA has on a topic — full histories, complete year-by-year records, in-depth accounts — for when query_reference_knowledge's short overview genuinely isn't enough and the person wants real depth. Multiple documents may exist for one category. IMPORTANT: call with just a category first — this returns a lightweight list of available document titles, not their full text. If the person wants one specific document read in full, call again passing its slug from that list; only then does the full text come back. Never assume a slug — always discover it via the category-only call first. Only use this tool at all when real detail is actually wanted; for a quick, casual question, query_reference_knowledge is almost always the better fit.",
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category to look up, e.g. "vincy_mas" — matches the same category names used by query_reference_knowledge' },
        slug: { type: 'string', description: 'Optional — the exact slug of one specific document, from a prior category-only call, to get its full text' },
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
    description: "Search AVA's own directory of real SVG businesses — restaurants, pharmacies, doctors, taxi services — sourced from Google Places and kept current. Use this before web search for 'where can I find X' or 'is there a Y near me' questions. If the person names a SPECIFIC business, always pass it as business_name — otherwise this returns an unfiltered list of the whole category, which is rarely what they actually asked for. Coverage is limited to what's been ingested so far (mainly Saint Vincent, Bequia, Union Island) — if nothing comes back, say so honestly rather than guessing at a business that might exist.",
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['restaurant', 'pharmacy', 'doctor', 'taxi_service', 'cinema', 'retailer', 'pop_up_vendor', 'accommodation', 'car_rental', 'promoter', 'nightlife'], description: 'What kind of business to look for' },
        island: { type: 'string', description: 'Optional — narrow to a specific island, e.g. "Bequia" or "Saint Vincent". Omit to search all islands.' },
        business_name: { type: 'string', description: 'If the person named a specific business, pass it here to filter to just that one — e.g. "Sky Lounge". Omit only for genuinely general category browsing.' },
      },
      required: ['category']
    }
  },
  {
    name: 'query_points_of_interest',
    description: "Look up real beaches, hiking trails, waterfalls, historic sites, gardens, and marine parks across Saint Vincent and the Grenadines — genuinely researched, named places, not general reference knowledge. If the person names a SPECIFIC place, always pass it as place_name — otherwise this returns an unfiltered list of the whole category, which is rarely what they actually asked for. Use this for 'what beaches should I visit' or 'best hikes on Saint Vincent' type questions. Coverage is a solid first pass, not exhaustive — if nothing comes back for a specific island or category, say so honestly.",
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['beach', 'hiking_trail', 'waterfall', 'historic_site', 'marine_park', 'garden'], description: 'Optional — narrow to a specific type of attraction. Omit to search all types.' },
        island: { type: 'string', description: 'Optional — narrow to a specific island, e.g. "Bequia" or "Saint Vincent". Omit to search all islands.' },
        place_name: { type: 'string', description: 'If the person named a specific place, pass it here to filter to just that one — e.g. "Macaroni Beach". Omit only for genuinely general category browsing.' },
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


const avaCore = require('./ava-core.js');


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

  // A real "Send enquiry" button click, not a conversational message —
  // deliberately bypasses Claude and the whole tool-calling loop entirely.
  // Relying on a long conversation to correctly remember contact details
  // turned out to be genuinely unreliable in real use; a direct form
  // submission with everything needed in one call isn't.
  if(body.action === 'send_enquiry'){
    const avaCore = require('./ava-core.js');
    if(!body.listing_id || !body.requester_contact || !body.details){
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'listing_id, requester_contact, and details are required' }) };
    }
    const result = await avaCore.requestFromBusiness(
      body.listing_id, body.offer_id || null, body.requester_name || null,
      body.requester_contact, body.details
    );
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
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
    // Request-scoped, not module-level — a warm function instance can
    // serve different users' concurrent requests, so this must reset for
    // every invocation, never leak across them. Caps full-document fetches
    // at one per request: a phrase like "the whole story" can reasonably
    // lead Claude to fetch multiple full documents sequentially across
    // loop iterations, which would silently rebuild the exact same
    // combined-size problem this was built to prevent, just spread across
    // several tool calls instead of one.
    let deepDiveFullTextCount = 0;
    const CUSTOM_TOOL_NAMES = ['get_deep_link', 'query_retail_price', 'query_multiple_retail_prices', 'query_news', 'query_economic_data', 'query_imf_data', 'query_ferry_schedule', 'generate_lucky_numbers', 'query_directory', 'query_health_data', 'query_scholarships', 'query_reference_knowledge', 'query_deep_dive', 'query_weather', 'query_marine_conditions', 'query_fuel_context', 'query_points_of_interest', 'plan_trip', 'query_taxi_fare', 'query_bus_fare', 'query_settlement_classification'];

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
        const toolExecutions = await Promise.all(toolUseBlocks.map(async (toolUse) => {
          let content = 'Unknown tool.';
          let retailResultEntry = null;
          const toolStartTime = Date.now();

          if(toolUse.name === 'get_deep_link'){
            const link = avaCore.buildDeepLink(toolUse.input.service_type, toolUse.input);
            if(link) linkCard = link;
            content = link ? `Link generated: ${link.url}` : 'Could not generate a link for that service type.';
          }

          else if(toolUse.name === 'query_news'){
            const newsData = await avaCore.queryNewsDB(toolUse.input.topic);
            if(newsData.results && newsData.results.length) newsResults = newsData.results;
            content = newsData.results && newsData.results.length
              ? newsData.results.map(a => `"${a.topic}" (${a.published_at ? new Date(a.published_at).toDateString() : 'undated'}): ${a.body} [source: ${a.source_url}]`).join('\n\n')
              : (newsData.note || 'No published articles found on that topic.');
          }

          else if(toolUse.name === 'query_retail_price'){
            const priceData = await avaCore.queryRetailPriceDB(toolUse.input.product_name);
            await avaCore.logProductInterest(toolUse.input.product_name, deviceId);
            // Returned rather than pushed directly — multiple price lookups
            // now run in parallel, and pushing here would let whichever one
            // happens to finish first determine display order, rather than
            // the order the person actually asked for their items in.
            retailResultEntry = {
              product: toolUse.input.product_name,
              results: priceData.results || [],
              note: (!priceData.results || !priceData.results.length) ? (priceData.note || 'No results found.') : null,
            };
            content = priceData.results && priceData.results.length
              ? `Found ${priceData.results.length} offer(s), cheapest first (normalized by price per lb or per gallon where the unit could be parsed, so this correctly compares different package sizes — e.g. a 10kg bag vs a 5lb bag): ` + priceData.results.map(r => {
                  const loc = [r.parish, r.island].filter(Boolean).join(', ');
                  const normalized = r.price_per_standard_unit ? ` [≈ $${r.price_per_standard_unit}/${r.standard_unit_type === 'weight_lb' ? 'lb' : 'gallon'}]` : '';
                  return `${r.retailer}: $${r.price}${r.unit ? '/' + r.unit : ''}${normalized}${loc ? ` (${loc})` : ''}${r.phone ? `, phone ${r.phone}` : ''}`;
                }).join('; ')
              : (priceData.note || 'No results found in the database for that product.');
          }

          else if(toolUse.name === 'query_multiple_retail_prices'){
            const multiData = await avaCore.queryMultipleRetailPrices(toolUse.input.product_names);
            await Promise.all((toolUse.input.product_names || []).map(name => avaCore.logProductInterest(name, deviceId)));
            // An array here rather than a single object — handled in the
            // post-processing step below alongside the single-item case.
            retailResultEntry = multiData.items;
            content = multiData.items.map(item =>
              item.results.length
                ? `${item.product}: ` + item.results.map(r => `${r.retailer}: $${r.price}${r.unit ? '/' + r.unit : ''}`).join(', ')
                : `${item.product}: ${item.note || 'No results found.'}`
            ).join('\n');
          }

          else if(toolUse.name === 'query_economic_data'){
            const econData = await avaCore.queryEconomicData(toolUse.input.indicator);
            content = econData.values && econData.values.length
              ? `${econData.indicator} (source: World Bank): ` + econData.values.map(v => `${v.year}: ${v.value}`).join(', ')
              : (econData.note || 'No data available for that indicator.');
          }

          else if(toolUse.name === 'query_imf_data'){
            const imfData = await avaCore.queryImfData(toolUse.input.indicator);
            content = imfData.values && imfData.values.length
              ? `${imfData.indicator} (source: IMF World Economic Outlook): ` + imfData.values.map(v => `${v.year}: ${v.value}`).join(', ') + '. Note: recent and future years in IMF WEO data are often forecasts, not confirmed actuals — say so if relevant.'
              : (imfData.note || 'No data available for that indicator.');
          }

          else if(toolUse.name === 'query_ferry_schedule'){
            const ferryData = await avaCore.queryFerrySchedule(toolUse.input.destination, toolUse.input.day_of_week);
            if(ferryData.results && ferryData.results.length) ferryResults = ferryData.results;
            content = ferryData.results && ferryData.results.length
              ? `Sailings found: ` + ferryData.results.map(s => `${s.operator}: ${s.origin} → ${s.destination} at ${s.departure_time}${s.fare_economy ? `, $${s.fare_economy} EC` : ''}`).join('; ') + '. Remind the person schedules can change — worth confirming directly before travel.'
              : (ferryData.note || 'No ferry data available for that route.');
          }

          else if(toolUse.name === 'generate_lucky_numbers'){
            const lucky = avaCore.generateLuckyNumbers(toolUse.input.game);
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
            const dirData = await avaCore.queryDirectory(toolUse.input.category, toolUse.input.island, toolUse.input.business_name);
            if(dirData.results && dirData.results.length) directoryResults = dirData.results;
            content = dirData.results && dirData.results.length
              ? `Found ${dirData.results.length}: ` + dirData.results.map(d => `${d.name} (listing_id: ${d.id})${d.island ? ` (${d.island})` : ''}${d.phone ? `, ${d.phone}` : ''}${d.is_top_pick ? ` [REAL ADMIN-CURATED TOP PICK: ${d.top_pick_note || 'no reason given'}]` : ''}`).join('; ') +
                (dirData.results.length >= 50 ? '\n\nNote: this hit the 50-result display limit — there may be more not shown. If relevant, tell the person you can narrow by island.' : '')
              : (dirData.note || 'No listings found.');
          }

          else if(toolUse.name === 'query_points_of_interest'){
            const poiData = await avaCore.queryPointsOfInterest(toolUse.input.category, toolUse.input.island, toolUse.input.place_name);
            content = poiData.results && poiData.results.length
              ? poiData.results.map(p => `"${p.name}" (${p.category.replace('_', ' ')}, ${p.island}): ${p.description}${p.source_url ? ` [source: ${p.source_url}]` : ''}`).join('\n\n')
              : (poiData.note || 'No attractions found.');
          }

          else if(toolUse.name === 'query_taxi_fare'){
            const fareData = await avaCore.queryTaxiFare(toolUse.input.origin, toolUse.input.destination);
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
            const busData = await avaCore.queryBusFare(toolUse.input.origin, toolUse.input.destination);
            if(busData.type === 'official'){
              content = `REAL OFFICIAL BUS FARE (Ministry of Transport and Works, ${busData.hub} to ${busData.place}): EC$${busData.regular_fare} regular. School children in uniform pay 50%: EC$${busData.student_fare}. State this confidently as the official government rate.`;
            } else {
              content = busData.note || 'No bus fare data available for this route.';
            }
          }

          else if(toolUse.name === 'query_settlement_classification'){
            const settlementData = await avaCore.querySettlementClassification(toolUse.input.place);
            if(settlementData.type === 'official'){
              content = `Official classification (National Physical Development Plan, 2021 draft): ${settlementData.name} is designated a ${settlementData.typology}, with a "${settlementData.spatial_strategy}" spatial strategy. Note this is a 2021 DRAFT planning document, not necessarily final/adopted policy — mention this is planning classification, not a tourist or business fact.`;
            } else {
              content = settlementData.note || 'No classification data available for this place.';
            }
          }

          else if(toolUse.name === 'plan_trip'){
            const plan = await avaCore.planTrip(
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
            const healthData = await avaCore.queryHealthData(toolUse.input.indicator);
            content = healthData.values && healthData.values.length
              ? `${healthData.indicator} (source: WHO Global Health Observatory): ` + healthData.values.map(v => `${v.year}: ${v.value}`).join(', ')
              : (healthData.note || 'No data available for that indicator.');
          }

          else if(toolUse.name === 'query_weather'){
            const weatherData = await avaCore.queryWeather();
            content = weatherData.current
              ? `Current in Kingstown, SVG (source: Open-Meteo): ${weatherData.current.temperature_c}°C, wind ${weatherData.current.wind_speed_kmh} km/h from ${weatherData.current.wind_direction_deg}°, precipitation ${weatherData.current.precipitation_mm}mm. Next few days: ` + weatherData.daily.map(d => `${d.date}: ${d.low_c}-${d.high_c}°C, ${d.precipitation_mm}mm rain`).join('; ')
              : (weatherData.note || 'No weather data available.');
          }

          else if(toolUse.name === 'query_marine_conditions'){
            const marineData = await avaCore.queryMarineConditions();
            content = marineData.wave_height_m !== undefined && marineData.wave_height_m !== null
              ? `Current marine conditions off SVG (source: Open-Meteo Marine, ICON Wave model): wave height ${marineData.wave_height_m}m from ${marineData.wave_direction_deg}°, wave period ${marineData.wave_period_s}s. Swell: ${marineData.swell_wave_height_m}m height, ${marineData.swell_wave_period_s}s period. Wind waves: ${marineData.wind_wave_height_m}m.`
              : (marineData.note || 'No marine conditions data available.');
          }

          else if(toolUse.name === 'query_fuel_context'){
            const fuelData = await avaCore.queryFuelContext();
            content = fuelData.recent_surcharge_news
              ? `Most recent actual VINLEC surcharge announcement from AVA's news database: "${fuelData.recent_surcharge_news.topic}" (${new Date(fuelData.recent_surcharge_news.published_at).toDateString()}) — ${fuelData.recent_surcharge_news.body} [source: ${fuelData.recent_surcharge_news.source_url}].

Real regulatory context: VINLEC's fuel surcharge is not arbitrary — it is governed by the Electricity Supply Act, with two separate internal VINLEC sections vetting the calculation. The government has set relief thresholds: if the surcharge exceeds EC$0.71/kWh, VINLEC must provide a 50% matching discount; above EC$0.77/kWh, a full 100% match applies.

IMPORTANT — how to use this: report the most recently announced rate as a fact about the past only. Do NOT predict, forecast, or imply what the surcharge will do next. Even VINLEC's own CEO has publicly said he "cannot offer a guarantee due to the volatility of global markets" and can only be "hopeful." If asked for an outlook, share the real most-recent rate and the real mechanism, and be explicit that you can't responsibly predict direction — that would require guessing at a genuinely volatile global market that professionals themselves won't forecast confidently.`
              : (fuelData.note || 'No fuel surcharge data available.');
          }

          else if(toolUse.name === 'query_scholarships'){
            const scholarshipData = await avaCore.queryScholarships();
            content = scholarshipData.results && scholarshipData.results.length
              ? scholarshipData.results.map(s => {
                  const verified = s.last_verified_at ? new Date(s.last_verified_at).toDateString() : 'unknown date';
                  return `"${s.name}" (${s.provider || 'provider unknown'}): ${s.description || ''} Eligibility: ${s.eligibility || 'not specified'}. Deadline: ${s.deadline || 'not specified'}. Apply: ${s.apply_url || 'see source'}. [Last verified ${verified} — mention this date and suggest confirming directly before applying, since deadlines can change]`;
                }).join('\n\n')
              : (scholarshipData.note || 'No scholarship data available.');
          }

          else if(toolUse.name === 'query_reference_knowledge'){
            const refData = await avaCore.queryReferenceKnowledge(toolUse.input.category);
            content = refData.result
              ? `${refData.result.title}: ${refData.result.summary} [Source: ${refData.result.source_url || 'unknown'}, last verified ${refData.result.last_verified_at ? new Date(refData.result.last_verified_at).toDateString() : 'unknown'}]`
              : (refData.note || 'No reference content available.');
          }

          else if(toolUse.name === 'query_deep_dive'){
            if(toolUse.input.slug && deepDiveFullTextCount >= 1){
              // Checked and incremented synchronously, before any await —
              // safe even if Claude requested two full documents in the
              // same batch, since JS never interleaves between two
              // synchronous statements.
              content = 'Only one full deep-dive document can be retrieved per request. Please synthesize your answer from the document already retrieved, or the category list, rather than fetching another full document.';
            } else {
              if(toolUse.input.slug) deepDiveFullTextCount++;
              const deepData = await avaCore.queryDeepDive(toolUse.input.category, toolUse.input.slug);
              if(deepData.result){
                content = `=== ${deepData.result.title} ===\n${deepData.result.body}\n[Source: ${deepData.result.source_url || 'unknown'}]`;
              } else if(deepData.list && deepData.list.length){
                content = `Available deep-dive documents for "${toolUse.input.category}" (call again with one of these exact slugs to get its full text): ` +
                  deepData.list.map(d => `"${d.title}" (slug: ${d.slug})`).join('; ');
              } else {
                content = deepData.note || 'No deep-dive content available.';
              }
            }
          }

          const toolElapsedMs = Date.now() - toolStartTime;
          console.log(`Tool timing — ${toolUse.name}: ${toolElapsedMs}ms — input: ${JSON.stringify(toolUse.input)} — returned: ${String(content).slice(0, 400)}`);

          return { toolUse, content, retailResultEntry };
        }));

        // Promise.all preserves input order in its output regardless of
        // which call actually finished first, so rebuilding both arrays
        // here — rather than pushing inside the parallel section above —
        // guarantees results land in the same order the person asked for
        // their items in, not whichever database round-trip happened to
        // come back first.
        const toolResults = toolExecutions.map(({ toolUse, content }) => ({ type: 'tool_result', tool_use_id: toolUse.id, content }));
        toolExecutions.forEach(({ retailResultEntry }) => {
          if(Array.isArray(retailResultEntry)) retailResults.push(...retailResultEntry);
          else if(retailResultEntry) retailResults.push(retailResultEntry);
        });

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
exports.queryRetailPriceDB = avaCore.queryRetailPriceDB;
exports.queryNewsDB = avaCore.queryNewsDB;
exports.queryEconomicData = avaCore.queryEconomicData;
exports.queryImfData = avaCore.queryImfData;
exports.queryFerrySchedule = avaCore.queryFerrySchedule;
exports.generateLuckyNumbers = avaCore.generateLuckyNumbers;
exports.queryDirectory = avaCore.queryDirectory;
exports.queryHealthData = avaCore.queryHealthData;
exports.queryFuelContext = avaCore.queryFuelContext;
exports.queryWeather = avaCore.queryWeather;
exports.queryMarineConditions = avaCore.queryMarineConditions;
exports.queryScholarships = avaCore.queryScholarships;
exports.queryReferenceKnowledge = avaCore.queryReferenceKnowledge;
exports.queryPointsOfInterest = avaCore.queryPointsOfInterest;
exports.planTrip = avaCore.planTrip;
exports.queryTaxiFare = avaCore.queryTaxiFare;
exports.queryBusFare = avaCore.queryBusFare;
exports.querySettlementClassification = avaCore.querySettlementClassification;
exports.buildDeepLink = avaCore.buildDeepLink;
