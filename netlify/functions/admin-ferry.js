// Review API for ferry proposals. The recheck agent only writes drafts; a ferry
// timetable changes only through "approve" here, which needs the admin password.
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const ferry = require('./ferry-core');
const core = require('./agent-core');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const store = ferry.makeStore(supabase);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

async function checkAuth(pw){
  const { data } = await supabase.from('admin_auth').select('password_hash').eq('id', 1).maybeSingle();
  const hash = data ? data.password_hash : null;
  return !!(hash && pw && await bcrypt.compare(pw, hash));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const pw = (event.headers || {})['x-admin-secret'] || (event.headers || {})['X-Admin-Secret'];
  if (!(await checkAuth(pw))) return json(401, { error: 'Unauthorized' });
  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    if (event.httpMethod === 'GET' && action === 'list') {
      const status = ['pending', 'approved', 'rejected'].includes(params.status) ? params.status : 'pending';
      return json(200, { drafts: await store.listDrafts(status) });
    }

    if (event.httpMethod === 'GET' && action === 'status') {
      const lock = await store.getLock();
      const routes = await store.routes();
      const rows = await store.schedules(routes.map(r => r.id));
      const newest = rows.map(r => r.last_verified_at).filter(Boolean).sort().pop() || null;
      const oldest = rows.map(r => r.last_verified_at).filter(Boolean).sort()[0] || null;
      return json(200, {
        last_started: lock.started_at || null, last_finished: lock.finished_at || null, summary: lock.summary || null,
        stored_sailings: rows.length, newest_verified: newest, oldest_verified: oldest,
        routes: routes.map(r => ({ operator: r.operator_name, from: r.origin_port, to: r.destination_port, active: r.active !== false })),
      });
    }

    if (event.httpMethod === 'POST' && ['run', 'approve', 'reject'].includes(action)) {
      const body = JSON.parse(event.body || '{}');
      if (action === 'run') {
        const wait = await ferry.lockedFor(store);
        if (wait) return json(200, { ok: true, message: `The ferry check already ran recently. It can run again in about ${Math.ceil(wait / 60)} hours. (This limit stops runaway API costs.)` });
        await core.triggerBackground('agent-ferry-background');
        return json(200, { ok: true, message: 'Ferry check started. Proposals appear here in a few minutes.' });
      }
      const draft = await store.getDraft(body.id);
      if (!draft) return json(404, { error: 'Proposal not found' });
      if (draft.status !== 'pending') return json(409, { error: `Proposal already ${draft.status}` });
      if (action === 'reject') { await store.setDraftStatus(draft.id, 'rejected'); return json(200, { ok: true }); }
      const result = await ferry.applyProposal(store, draft);
      await store.setDraftStatus(draft.id, 'approved');
      return json(200, { ok: true, result });
    }
    return json(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('admin-ferry error:', err);
    return json(err.status || 500, { error: err.message });
  }
};
