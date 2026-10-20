// Admin: review posted jobs. Approving opens the job for 3 days and returns the
// WhatsApp message for the dispatcher to send. Nothing is sent automatically.
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const SITE = process.env.SITE_URL || 'https://askvincy.com';
const OPEN_DAYS = 3;
const reply = (code, obj) => ({ statusCode: code, headers: CORS, body: JSON.stringify(obj) });

function waLink(job) {
  const text = `Hello from AVA. Your job "${job.description.slice(0, 60)}" has been approved. Providers can now send you quotes. Your private link: ${SITE}/job/${job.token}`;
  return `https://web.whatsapp.com/send?phone=${job.whatsapp_number}&text=${encodeURIComponent(text)}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const provided = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'] || '';
  const { data: authRow } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  if (!authRow || !provided || !(await bcrypt.compare(provided, authRow.password_hash))) return reply(401, { error: 'Unauthorized' });

  const action = (event.queryStringParameters || {}).action;
  let body = {};
  if (event.httpMethod === 'POST') { try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Bad request.' }); } }

  try {
    if (action === 'list') {
      const status = ['pending', 'open', 'closed', 'accepted', 'reported'].includes((event.queryStringParameters || {}).status) ? event.queryStringParameters.status : 'pending';
      const { data, error } = await supabase.from('jobs')
        .select('id,token,description,category,island,from_place,to_place,when_text,budget_text,whatsapp_number,photos,status,expires_at,created_at')
        .eq('status', status).order('created_at', { ascending: true }).limit(100);
      if (error) throw error;
      return reply(200, { jobs: data || [] });
    }
    if (action === 'approve') {
      const { data: job } = await supabase.from('jobs').select('*').eq('id', body.id).maybeSingle();
      if (!job) return reply(404, { error: 'Job not found.' });
      if (job.status !== 'pending') return reply(400, { error: 'This job was already handled.' });
      const now = new Date();
      const { error } = await supabase.from('jobs').update({
        status: 'open', approved_at: now.toISOString(),
        expires_at: new Date(now.getTime() + OPEN_DAYS * 86400000).toISOString(), last_activity_at: now.toISOString(),
      }).eq('id', job.id).eq('status', 'pending');
      if (error) throw error;
      await supabase.from('job_events').insert({ job_id: job.id, kind: 'approved' });
      return reply(200, { ok: true, whatsapp_link: waLink(job) });
    }
    if (action === 'reject') {
      const { data: job } = await supabase.from('jobs').select('id,status').eq('id', body.id).maybeSingle();
      if (!job) return reply(404, { error: 'Job not found.' });
      if (job.status !== 'pending') return reply(400, { error: 'This job was already handled.' });
      // Rejected jobs are deleted outright, with their photos' rows and any events.
      const { error } = await supabase.from('jobs').delete().eq('id', job.id);
      if (error) throw error;
      return reply(200, { ok: true });
    }
    return reply(400, { error: 'Unknown action.' });
  } catch (e) {
    console.error('jobs-admin error:', e.message);
    return reply(500, { error: 'Something went wrong. Check the Netlify function logs for jobs-admin.' });
  }
};
