const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `You are AVA — "Ask Vincy Anything" — a warm, knowledgeable local concierge for daily life, tourism, and travel in Saint Vincent and the Grenadines (SVG). You are talking to residents, diaspora, and visitors.

Rules:
- Use web search for anything current or specific: schedules, prices, hours, events, news. Don't guess at facts that could be out of date.
- For questions about grocery, retail, or product prices at specific stores/retailers, use the query_retail_price tool first — it checks AVA's own database of prices submitted directly by real retailers. This data is early and limited (only a handful of retailers have submitted so far), so if it returns nothing or very little, say so honestly rather than presenting it as a complete market picture, and you may supplement with web search for general context.
- Be concise, warm, and specific — like a well-connected local friend, not a corporate chatbot. Avoid filler.
- When someone wants to book or search flights, hotels, car rentals, or event tickets, call the get_deep_link tool to hand them to the real platform. Never claim you can book, pay, or hold a reservation yourself.
- For civic/legal topics (like the UK ETA, immigration, or medical questions), give accurate general guidance but make clear where to go for anything requiring an official/formal step.
- If you don't have enough information after searching, say so plainly rather than guessing.
- Keep answers to a few short paragraphs unless the question genuinely needs more.`;

const TOOLS = [
  { type: 'web_search_20250305', name: 'web_search' },
  {
    name: 'get_deep_link',
    description: 'Generate a link to a real external platform for booking flights, hotels, car rentals, or finding event tickets. Use this instead of claiming you can book something yourself.',
    input_schema: {
      type: 'object',
      properties: {
        service_type: { type: 'string', enum: ['flights','hotels','cars','events'] },
        origin: { type: 'string', description: 'For flights: departure city/airport' },
        destination: { type: 'string', description: 'For flights: arrival city/airport, defaults to SVG' },
        date: { type: 'string', description: 'For flights: travel date if known' },
        location: { type: 'string', description: 'For hotels/cars/events: location, defaults to SVG' },
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
  return null;
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
      return { results: [], note: "No matching product found in AVA's database yet — this may not have been submitted by any retailer." };
    }
    const productIds = products.map(p => p.id);

    const { data: offers, error: offerErr } = await supabase
      .from('retail_offers')
      .select('item_name, price, unit, photo_url, listing_id, created_at')
      .in('canonical_product_id', productIds)
      .order('price', { ascending: true });
    if(offerErr) throw offerErr;
    if(!offers || !offers.length){
      return { results: [], note: 'That product exists in the database but no retailer currently has an offer for it.' };
    }

    const listingIds = [...new Set(offers.map(o => o.listing_id))];
    const { data: listings, error: listErr } = await supabase
      .from('directory_listings')
      .select('id, name, island, phone')
      .in('id', listingIds);
    if(listErr) throw listErr;
    const listingMap = Object.fromEntries((listings || []).map(l => [l.id, l]));

    const results = offers.map(o => ({
      retailer: (listingMap[o.listing_id] && listingMap[o.listing_id].name) || 'Unknown retailer',
      island: (listingMap[o.listing_id] && listingMap[o.listing_id].island) || null,
      item_name: o.item_name,
      price: o.price,
      unit: o.unit,
      photo_url: o.photo_url,
    }));
    return { results };
  } catch(err){
    console.error('queryRetailPriceDB error:', err);
    return { results: [], note: 'Could not reach the price database right now.' };
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
      system: SYSTEM_PROMPT,
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
    let retailResults = null;
    let loops = 0;

    while(loops < 4){
      loops++;
      const data = await callClaude(messages);
      const toolUse = (data.content || []).find(b => b.type === 'tool_use' && (b.name === 'get_deep_link' || b.name === 'query_retail_price'));
      const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n');
      if(textBlocks) finalText += (finalText ? '\n\n' : '') + textBlocks;

      if(toolUse && toolUse.name === 'get_deep_link'){
        const link = buildDeepLink(toolUse.input.service_type, toolUse.input);
        if(link) linkCard = link;
        messages = messages.concat([
          { role: 'assistant', content: data.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: link ? `Link generated: ${link.url}` : 'Could not generate a link for that service type.' }] },
        ]);
        continue;
      }

      if(toolUse && toolUse.name === 'query_retail_price'){
        const priceData = await queryRetailPriceDB(toolUse.input.product_name);
        if(priceData.results && priceData.results.length) retailResults = priceData.results;
        const summary = priceData.results && priceData.results.length
          ? `Found ${priceData.results.length} offer(s), cheapest first: ` + priceData.results.map(r => `${r.retailer}: $${r.price}${r.unit ? '/' + r.unit : ''}`).join('; ')
          : (priceData.note || 'No results found in the database for that product.');
        messages = messages.concat([
          { role: 'assistant', content: data.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: summary }] },
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
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ text: finalText, linkCard, retailResults }) };
  } catch(err){
    console.error('ava-chat error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error: ' + err.message }) };
  }
};
