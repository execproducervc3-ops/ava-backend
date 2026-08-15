const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Deliberately a fixed, individually-verified list rather than an open-ended
// "find all scholarships" sweep — an unbounded search can't be checked for
// accuracy, and presenting a wrong/expired funding opportunity as real is a
// worse failure than a stale ferry time, since someone might act on it.
// New programs get added here deliberately, not auto-discovered.
const PROGRAMS = [
  'Commonwealth Scholarship and Fellowship Plan for Saint Vincent and the Grenadines students',
  'Chevening Scholarships UK for Saint Vincent and the Grenadines applicants',
  'Taiwan ROC government scholarships for Saint Vincent and the Grenadines students',
  'Caribbean Development Bank scholarships for Saint Vincent and the Grenadines students',
  'Saint Vincent and the Grenadines National Scholarship government of SVG',
];

function extractJson(text){
  if(!text) return null;
  // Claude sometimes wraps JSON in markdown fences despite instructions not to —
  // strip those before parsing rather than fail on a cosmetic formatting choice.
  const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
  try{
    return JSON.parse(cleaned);
  } catch(e){
    // Last resort: find the first {...} block in case there's stray text around it
    const match = cleaned.match(/\{[\s\S]*\}/);
    if(match){
      try{ return JSON.parse(match[0]); } catch(e2){ return null; }
    }
    return null;
  }
}

async function researchProgram(programHint){
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Research the CURRENT status of this scholarship/funding program, specifically for applicants from Saint Vincent and the Grenadines: "${programHint}". Find the official source — not an aggregator or forum post.

Respond with ONLY a JSON object, no other text, no markdown code fences, in exactly this shape:
{"found": true, "name": "official program name", "provider": "organization that runs it", "description": "2-3 sentence summary of what it covers", "eligibility": "1-2 sentence summary of who can apply, specific to SVG/Caribbean eligibility if relevant", "deadline": "current deadline or application window exactly as stated by the official source", "apply_url": "official application page URL", "source_url": "the official page you found this on"}

If you cannot find current, reliable, official information for this specific program, respond with exactly:
{"found": false, "name": "${programHint}"}`,
      }],
    }),
  });
  if(!res.ok){
    const errBody = await res.text().catch(() => '');
    throw new Error(`Anthropic API failed: ${res.status} ${errBody}`.trim());
  }
  const data = await res.json();
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extractJson(textBlocks);
}

exports.handler = async () => {
  const results = [];

  for(const programHint of PROGRAMS){
    try{
      const parsed = await researchProgram(programHint);

      if(!parsed || parsed.found !== true){
        // A research miss should never overwrite a previously-verified good
        // row — that would silently destroy real data over a transient search
        // failure. Just log it and move on; the existing row (if any) stays.
        results.push({ program: programHint, status: 'not_found_or_unparseable' });
        continue;
      }

      const { error: upsertErr } = await supabase.from('scholarships').upsert({
        name: parsed.name || programHint,
        provider: parsed.provider || null,
        description: parsed.description || null,
        eligibility: parsed.eligibility || null,
        deadline: parsed.deadline || null,
        apply_url: parsed.apply_url || null,
        source_url: parsed.source_url || null,
        last_verified_at: new Date().toISOString(),
        active: true,
      }, { onConflict: 'name' });

      if(upsertErr){
        results.push({ program: programHint, status: 'db_error', error: upsertErr.message });
        continue;
      }
      results.push({ program: programHint, status: 'updated' });
    } catch(err){
      console.error(`recheck-scholarships error for "${programHint}":`, err);
      results.push({ program: programHint, status: 'error', error: err.message });
    }
  }

  return { statusCode: 200, body: JSON.stringify({ results }) };
};
