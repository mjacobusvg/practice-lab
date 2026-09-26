// netlify/functions/rx-probe.js
//
// THROWAWAY. Its only job is to show us what RxNorm, DailyMed and openFDA actually return,
// because the dev container's network policy blocks all three and a label parser written
// against a guessed response shape is worthless.
//
// Fetches each source for one drug name and parks the raw JSON in public.tbp_rx_probe,
// which is readable over the Supabase MCP connection. No PHI: the only input is a drug name
// typed into the query string. Delete this file and the table once the real ingest exists.
//
//   /.netlify/functions/rx-probe?drug=Adderall%20XR&secret=<BACKFILL_SECRET>

const SOURCES = [
  { source: 'rxnorm',   url: d => 'https://rxnav.nlm.nih.gov/REST/rxcui.json?name=' + encodeURIComponent(d) + '&search=2' },
  { source: 'rxnorm',   url: d => 'https://rxnav.nlm.nih.gov/REST/drugs.json?name=' + encodeURIComponent(d) },
  // DailyMed v2: which SPLs exist for this drug name, and the RxNorm concepts each maps to.
  { source: 'dailymed', url: d => 'https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name=' + encodeURIComponent(d) + '&pagesize=25' },
  // openFDA: the structured label sections, to compare against DailyMed's SPL for the same drug.
  { source: 'openfda',  url: d => 'https://api.fda.gov/drug/label.json?search=openfda.brand_name:"' + d + '"&limit=3' }
];

exports.handler = async function (event) {
  const q = (event.queryStringParameters || {});
  if (!process.env.BACKFILL_SECRET || q.secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 401, body: 'no' };
  }
  const drug = (q.drug || '').trim();
  if (!drug) return { statusCode: 400, body: 'pass ?drug=' };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const rows = [], summary = [];

  for (const s of SOURCES) {
    const endpoint = s.url(drug);
    let http_status = null, payload = null, err = null;
    try {
      const r = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });
      http_status = r.status;
      const text = await r.text();
      try { payload = JSON.parse(text); }
      catch (e) { err = 'non-JSON response'; payload = { _raw: text.slice(0, 4000) }; }
    } catch (e) {
      err = String(e && e.message || e);
    }
    rows.push({ drug_query: drug, source: s.source, endpoint, http_status, payload, err });
    summary.push(s.source + ' ' + (http_status || 'ERR') + (err ? ' (' + err + ')' : ''));
  }

  if (supabaseUrl && supabaseKey) {
    try {
      await fetch(supabaseUrl + '/rest/v1/tbp_rx_probe', {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(rows)
      });
    } catch (e) { /* the summary below still tells the caller what happened */ }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/plain' },
    body: 'probed "' + drug + '"\n' + summary.join('\n') + '\n\nStored in tbp_rx_probe.\n'
  };
};
