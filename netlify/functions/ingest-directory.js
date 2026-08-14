const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Categories validated months ago as having decent real coverage for SVG.
// Each entry maps a real search query to our schema's category enum and island.
const SEARCH_QUERIES = [
  { query: 'restaurants in Kingstown, Saint Vincent and the Grenadines', category: 'restaurant', island: 'Saint Vincent' },
  { query: 'pharmacies in Kingstown, Saint Vincent and the Grenadines', category: 'pharmacy', island: 'Saint Vincent' },
  { query: 'doctors in Kingstown, Saint Vincent and the Grenadines', category: 'doctor', island: 'Saint Vincent' },
  { query: 'taxi service in Kingstown, Saint Vincent and the Grenadines', category: 'taxi_service', island: 'Saint Vincent' },
  { query: 'restaurants in Bequia, Saint Vincent and the Grenadines', category: 'restaurant', island: 'Bequia' },
  { query: 'pharmacies in Bequia, Saint Vincent and the Grenadines', category: 'pharmacy', island: 'Bequia' },
  { query: 'taxi service in Bequia, Saint Vincent and the Grenadines', category: 'taxi_service', island: 'Bequia' },
  { query: 'restaurants in Union Island, Saint Vincent and the Grenadines', category: 'restaurant', island: 'Union Island' },
];

const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.nationalPhoneNumber,places.location,places.businessStatus';

async function searchPlaces(textQuery){
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({ textQuery }),
  });
  if(!res.ok){
    const errBody = await res.text().catch(() => '');
    throw new Error(`Places API failed: ${res.status} ${errBody}`.trim());
  }
  const data = await res.json();
  return data.places || [];
}

async function processQuery(searchDef){
  const result = { query: searchDef.query, found: 0, inserted: 0, skipped_duplicate: 0, skipped_closed: 0, errors: [] };

  const places = await searchPlaces(searchDef.query);
  result.found = places.length;

  for(const place of places){
    try{
      if(place.businessStatus && place.businessStatus !== 'OPERATIONAL'){
        result.skipped_closed++;
        continue;
      }

      const { data: existing } = await supabase
        .from('directory_listings')
        .select('id')
        .eq('source', 'google_places')
        .eq('source_id', place.id)
        .maybeSingle();
      if(existing){ result.skipped_duplicate++; continue; }

      const name = place.displayName && place.displayName.text ? place.displayName.text : null;
      if(!name) continue;

      const { error: insErr } = await supabase.from('directory_listings').insert({
        category: searchDef.category,
        name,
        address: place.formattedAddress || null,
        island: searchDef.island,
        lat: place.location ? place.location.latitude : null,
        lng: place.location ? place.location.longitude : null,
        phone: place.internationalPhoneNumber || place.nationalPhoneNumber || null,
        source: 'google_places',
        source_id: place.id,
        status: 'active',
        verified_by: 'agent_ingestion',
        confidence_score: 0.75,
        last_verified_at: new Date().toISOString(),
      });
      if(insErr){
        if(insErr.code === '23505'){ result.skipped_duplicate++; }
        else { result.errors.push(`Insert failed for "${name}": ${insErr.message}`); }
        continue;
      }
      result.inserted++;
    } catch(itemErr){
      result.errors.push(`Error processing a place: ${itemErr.message}`);
    }
  }

  return result;
}

exports.handler = async () => {
  if(!PLACES_KEY){
    return { statusCode: 500, body: JSON.stringify({ error: 'GOOGLE_PLACES_API_KEY is not set' }) };
  }

  const byQuery = [];
  const totals = { found: 0, inserted: 0, skipped_duplicate: 0, skipped_closed: 0, errors: 0 };

  for(const searchDef of SEARCH_QUERIES){
    try{
      const result = await processQuery(searchDef);
      byQuery.push(result);
      totals.found += result.found;
      totals.inserted += result.inserted;
      totals.skipped_duplicate += result.skipped_duplicate;
      totals.skipped_closed += result.skipped_closed;
      totals.errors += result.errors.length;
    } catch(queryErr){
      console.error(`ingest-directory error for "${searchDef.query}":`, queryErr);
      byQuery.push({ query: searchDef.query, found: 0, inserted: 0, skipped_duplicate: 0, skipped_closed: 0, errors: [queryErr.message] });
      totals.errors += 1;
    }
  }

  return { statusCode: 200, body: JSON.stringify({ totals, byQuery }) };
};
