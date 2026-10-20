// Public: the customer's private job page data, looked up by the secret token.
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

exports.handler = async (event) => {
  const token = String((event.queryStringParameters || {}).token || '');
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'not found' }) };
  const { data: job } = await supabase.from('jobs')
    .select('id,description,category,island,from_place,to_place,when_text,budget_text,photos,status,expires_at,max_quotes')
    .eq('token', token).maybeSingle();
  if (!job || job.status === 'rejected') return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'not found' }) };
  const { count } = await supabase.from('job_quotes').select('id', { count: 'exact', head: true }).eq('job_id', job.id);
  delete job.id;
  return { statusCode: 200, headers: H, body: JSON.stringify({ job, quote_count: count || 0 }) };
};
