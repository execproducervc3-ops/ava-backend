const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Fixed, deliberately-grown list — same reasoning as scholarships. General
// "knowledge" content has more surface area for both inaccuracy and
// copyright drift than a short factual extraction, so scope stays bounded
// and each category is individually reviewable, not auto-expanded.
const CATEGORIES = [
  { category: 'geography', title: 'Geography of Saint Vincent and the Grenadines' },
  { category: 'history', title: 'History of Saint Vincent and the Grenadines' },
  { category: 'government', title: 'Government and political structure of Saint Vincent and the Grenadines' },
  { category: 'culture', title: 'Culture of Saint Vincent and the Grenadines' },
  { category: 'economy', title: 'Economy of Saint Vincent and the Grenadines' },
];

function extractJson(text){
  if(!text) return null;
  const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
  try{ return JSON.parse(cleaned); }
  catch(e){
    const match = cleaned.match(/\{[\s\S]*\}/);
    if(match){ try{ return JSON.parse(match[0]); } catch(e2){ return null; } }
    return null;
  }
}

async function researchCategory(entry){
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Research this topic: "${entry.title}". Use web search to check current, accurate facts.

Then write a SHORT factual overview — 3 to 5 sentences, no more — entirely in your own original words, for a conversational assistant to reference when someone asks about this topic casually.

Critical requirements:
- Do NOT closely mirror the phrasing, sentence structure, or flow of any single source, even if you checked several sources.
- Do NOT reproduce or closely paraphrase any specific passage — write a genuinely original synthesis of the general facts, not a rewording of one article.
- Keep it concise and conversational, not encyclopedic — this is a quick factual grounding, not a comprehensive article.
- Stick to durable, non-controversial facts (geography, history, structure) rather than anything current-events-adjacent or politically contested.

Respond with ONLY a JSON object, no other text, no markdown fences:
{"found": true, "title": "${entry.title}", "summary": "your original 3-5 sentence summary", "source_url": "one representative source URL you checked"}

If you cannot find reliable information, respond with exactly:
{"found": false, "title": "${entry.title}"}`,
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

  for(const entry of CATEGORIES){
    try{
      const parsed = await researchCategory(entry);

      if(!parsed || parsed.found !== true || !parsed.summary){
        // Same rule as scholarships: a research miss never overwrites a
        // previously-verified good row.
        results.push({ category: entry.category, status: 'not_found_or_unparseable' });
        continue;
      }

      const { error: upsertErr } = await supabase.from('reference_knowledge').upsert({
        category: entry.category,
        title: parsed.title || entry.title,
        summary: parsed.summary,
        source_url: parsed.source_url || null,
        last_verified_at: new Date().toISOString(),
        active: true,
      }, { onConflict: 'category' });

      if(upsertErr){
        results.push({ category: entry.category, status: 'db_error', error: upsertErr.message });
        continue;
      }
      results.push({ category: entry.category, status: 'updated' });
    } catch(err){
      console.error(`recheck-reference error for "${entry.category}":`, err);
      results.push({ category: entry.category, status: 'error', error: err.message });
    }
  }

  return { statusCode: 200, body: JSON.stringify({ results }) };
};
