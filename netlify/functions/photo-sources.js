// Runs every photo source for one target and merges the proposals.
//   places:  Wikimedia Commons, then Openverse if Commons found fewer than 2
//   species: Wikimedia Commons, then iNaturalist (by scientific name)
// One source failing never loses what another found.
const commons = require('./commons-photos');
const inat = require('./inat-photos');
const openverse = require('./openverse-photos');

async function findAll(target, fetchFn, kind) {
  const out = new Map();
  const errors = [];
  const add = (list, provider) => { for (const c of list || []) if (!out.has(c.image_url)) out.set(c.image_url, Object.assign({ provider }, c)); };
  try { add(await commons.findCandidates(target, fetchFn, 3), 'wikimedia'); } catch (e) { errors.push(`Wikimedia: ${e.message}`); }
  if (kind === 'species' && target.scientific) {
    try { add(await inat.findCandidates(target, fetchFn, 3), 'inaturalist'); } catch (e) { errors.push(`iNaturalist: ${e.message}`); }
  }
  if (kind === 'place' && out.size < 2) {
    try { add(await openverse.findCandidates(target, fetchFn, 3), 'openverse'); } catch (e) { errors.push(`Openverse: ${e.message}`); }
  }
  return { candidates: [...out.values()].sort((a, b) => b.score - a.score), errors };
}

module.exports = { findAll };
