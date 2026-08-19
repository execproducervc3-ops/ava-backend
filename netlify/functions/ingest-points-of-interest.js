const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Deliberately targets only the islands flagged as thin — Saint Vincent and
// Bequia already have real depth from earlier manual research, so this
// doesn't re-search islands that don't need it.
const SEARCH_QUERIES = [
  { query: 'beaches in Canouan, Saint Vincent and the Grenadines', island: 'Canouan' },
  { query: 'things to do in Canouan, Saint Vincent and the Grenadines', island: 'Canouan' },
  { query: 'beaches in Mustique, Saint Vincent and the Grenadines', island: 'Mustique' },
  { query: 'things to do in Mustique, Saint Vincent and the Grenadines', island: 'Mustique' },
  { query: 'beaches in Union Island, Saint Vincent and the Grenadines', island: 'Union Island' },
  { query: 'hiking trails in Union Island, Saint Vincent and the Grenadines', island: 'Union Island' },
  { query: 'things to do in Mayreau, Saint Vincent and the Grenadines', island: 'Mayreau' },
  { query: 'beaches in Mayreau, Saint Vincent and the Grenadines', island: 'Mayreau' },
  { query: 'things to do in Palm Island, Saint Vincent and the Grenadines', island: 'Palm Island' },
  { query: 'attractions Petit Saint Vincent, Saint Vincent and the Grenadines', island: 'Petit Saint Vincent' },
];

const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress';

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
  const result = { query: searchDef.query, found: 0, already_covered: 0, already_flagged: 0, newly_flagged: 0, errors: [] };

  const places = await searchPlaces(searchDef.query);
  result.found = places.length;

  for(const place of places){
    try{
      const name = place.displayName && place.displayName.text ? place.displayName.text : null;
      if(!name) continue;

      // Skip anything already a real, published point of interest.
      const { data: existingPoi } = await supabase
        .from('points_of_interest')
        .select('id')
        .ilike('name', name)
        .eq('island', searchDef.island)
        .maybeSingle();
      if(existingPoi){ result.already_covered++; continue; }

      // Skip anything already sitting in the gap queue from a prior run —
      // this job runs weekly, so without this check it would re-flag the
      // exact same candidates every time.
      const gapQueryText = `attraction: ${name} on ${searchDef.island}`;
      const { data: existingGap } = await supabase
        .from('unanswered_queries')
        .select('id')
        .ilike('query_text', gapQueryText)
        .maybeSingle();
      if(existingGap){ result.already_flagged++; continue; }

      const { error: insErr } = await supabase.from('unanswered_queries').insert({
        query_text: gapQueryText,
        category_guess: 'points_of_interest',
        resolved: false,
      });
      if(insErr){ result.errors.push(`Insert failed for "${name}": ${insErr.message}`); continue; }
      result.newly_flagged++;
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
  const totals = { found: 0, already_covered: 0, already_flagged: 0, newly_flagged: 0, errors: 0 };

  for(const searchDef of SEARCH_QUERIES){
    try{
      const result = await processQuery(searchDef);
      byQuery.push(result);
      totals.found += result.found;
      totals.already_covered += result.already_covered;
      totals.already_flagged += result.already_flagged;
      totals.newly_flagged += result.newly_flagged;
      totals.errors += result.errors.length;
    } catch(queryErr){
      console.error(`ingest-points-of-interest error for "${searchDef.query}":`, queryErr);
      byQuery.push({ query: searchDef.query, found: 0, already_covered: 0, already_flagged: 0, newly_flagged: 0, errors: [queryErr.message] });
      totals.errors += 1;
    }
  }

  // Newly flagged candidates land in the existing "Knowledge gaps" admin
  // panel automatically — nothing here publishes directly. Each one still
  // goes through the same real Claude+web-search research and human
  // review step every other point of interest went through tonight.
  return { statusCode: 200, body: JSON.stringify({ totals, byQuery }) };
};
