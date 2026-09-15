/* Offline checks for the Bedrock proxies' cache metering.
 *
 *   node test/bedrock-usage-checks.mjs
 *
 * Context: AWS Support case 178934455100974. Prompt caching was working and visible on the
 * bill, but invisible to our metering, because the cache counters were read from
 * message_start where they are absent or zero. These tests pin the corrected behaviour:
 * the counts come from the finalized usage, Bedrock's own invocationMetrics win over the
 * Anthropic-shaped numbers, the cache-write multiplier follows the TTL that was actually
 * requested, and the per-model checkpoint minimum is respected.
 *
 * No AWS calls. The helpers are read out of the deployed lambda source so the tests
 * exercise the code that gets pasted into Lambda, not a copy of it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['clinical-proxy-stream-bedrock.mjs', 'clinical-proxy-bedrock.mjs']
  .map(n => [n, readFileSync(join(root, 'aws-lambda', n), 'utf8')]);

let failures = 0;
const is = (cond, n, extra = '') => {
  if (cond) console.log('  PASS  ' + n + (extra ? '  ' + extra : ''));
  else { failures++; console.log('  FAIL  ' + n + (extra ? '  ' + extra : '')); }
};

/* Lift a top-level declaration by brace matching. */
function grab(src, sig) {
  const i = src.indexOf(sig);
  if (i === -1) throw new Error('not found: ' + sig);
  let d = 0, j = i;
  for (;; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; }
  return src.slice(i, j + 1);
}
function loadHelpers(src) {
  const parts = [
    'const MODEL_COST_PER_MTOK = {', 'const CACHE_WRITE_MULTIPLIER = {',
    'function estCostUsd(', 'const CACHE_MIN_TOKENS = {', 'const CACHE_5M_TOOLS = [',
    'function cacheTtlFor(', 'function cacheableSystem(', 'function newUsageAcc(', 'function readUsage(',
  ].map(sig => sig.startsWith('const CACHE_5M_TOOLS')
      ? src.slice(src.indexOf(sig), src.indexOf('];', src.indexOf(sig)) + 2)
      : grab(src, sig));
  const cpt = src.match(/const CHARS_PER_TOKEN = [\d.]+;/)[0] + '\n' +
              src.match(/const CACHE_TTL_DEFAULT = '[^']+';/)[0];
  const g = {};
  new Function('g', parts.join('\n') + '\n' + cpt +
    '\ng.estCostUsd=estCostUsd; g.cacheableSystem=cacheableSystem; g.cacheTtlFor=cacheTtlFor;' +
    ' g.newUsageAcc=newUsageAcc; g.readUsage=readUsage; g.CACHE_MIN_TOKENS=CACHE_MIN_TOKENS;' +
    ' g.CACHE_TTL_DEFAULT=CACHE_TTL_DEFAULT;')(g);
  return g;
}

/* Both files are pasted separately into two Lambdas and drift silently. Run every test
   against both. */
for (const [name, src] of files) {
  console.log('\n' + name);
  const H = loadHelpers(src);

  /* ── Where the cache counts come from ─────────────────────────────────────────── */

  /* The bug, reproduced: message_start reports the cache fields as zero. */
  const a = H.newUsageAcc();
  H.readUsage({ type: 'message_start', message: { usage: { input_tokens: 9000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }, a);
  is(a.cacheReadTokens === 0 && a.usageSource === 'message_start', 'message_start alone still yields zero cache reads (the old behaviour)');

  /* ...and the fix: Bedrock's metrics on the final chunk overwrite it. */
  H.readUsage({ type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 1200, outputTokenCount: 430, cacheReadInputTokenCount: 7800, cacheWriteInputTokenCount: 0 } }, a);
  is(a.cacheReadTokens === 7800 && a.inputTokens === 1200 && a.outputTokens === 430,
     'invocationMetrics on the final chunk supersede message_start', `read=${a.cacheReadTokens} in=${a.inputTokens}`);
  is(a.usageSource === 'bedrock-metrics' && a.authoritative === true, 'the authoritative source is recorded');

  /* Once Bedrock has spoken, a later Anthropic-shaped event must not undo it. */
  H.readUsage({ type: 'message_delta', usage: { output_tokens: 430, cache_read_input_tokens: 0 } }, a);
  is(a.cacheReadTokens === 7800, 'a trailing message_delta cannot zero out the authoritative cache count');

  /* Without invocationMetrics, message_delta is still better than message_start. */
  const b = H.newUsageAcc();
  H.readUsage({ type: 'message_start', message: { usage: { input_tokens: 500, output_tokens: 1 } } }, b);
  H.readUsage({ type: 'message_delta', usage: { output_tokens: 900, cache_read_input_tokens: 6000, cache_creation_input_tokens: 120 } }, b);
  is(b.cacheReadTokens === 6000 && b.cacheCreationTokens === 120 && b.outputTokens === 900,
     'message_delta supplies the cache counts when Bedrock metrics are absent');

  /* Garbage must never throw inside the streaming hot path. */
  const c = H.newUsageAcc();
  for (const junk of [null, undefined, 'ping', 42, {}, { type: 'content_block_delta', delta: { text: 'hi' } }]) H.readUsage(junk, c);
  is(c.inputTokens === null && c.usageSource === null, 'keep-alives and content events leave the meter untouched');

  /* ── Cost ─────────────────────────────────────────────────────────────────────── */

  /* A cached Sonnet call: 1.2k fresh input, 7.8k read from cache, 430 out.
     fresh 1200*3 + read 7800*3*0.1 + out 430*15 = 3600 + 2340 + 6450 = 12390 / 1e6 */
  is(H.estCostUsd('claude-sonnet-4-6', 1200, 430, 0, 7800, '5m') === 0.01239,
     'a cache read is priced at 0.1x', String(H.estCostUsd('claude-sonnet-4-6', 1200, 430, 0, 7800, '5m')));

  /* The same call metered the old way, with the cache invisible: all 9000 input tokens
     billed at the full rate. This is the overstatement the case was opened about. */
  const blind = H.estCostUsd('claude-sonnet-4-6', 9000, 430, 0, 0, '5m');
  const real = H.estCostUsd('claude-sonnet-4-6', 1200, 430, 0, 7800, '5m');
  is(blind > real * 2, 'metering blind to the cache overstates a cached call by more than 2x',
     `blind=${blind} vs real=${real} (${(blind / real).toFixed(2)}x)`);

  /* Write multiplier follows the requested TTL: 1.25x for 5m, 2x for 1h. */
  const w5 = H.estCostUsd('claude-sonnet-4-6', 0, 0, 10000, 0, '5m');
  const w1h = H.estCostUsd('claude-sonnet-4-6', 0, 0, 10000, 0, '1h');
  is(w5 === 0.0375 && w1h === 0.06, 'cache write is 1.25x on 5m and 2x on 1h', `5m=${w5} 1h=${w1h}`);
  is(H.estCostUsd('claude-sonnet-4-6', 0, 0, 10000, 0, undefined) === w5,
     'an unspecified TTL is priced as the 5 minute default, not the 1 hour rate');
  is(H.estCostUsd('made-up-model', 100, 100, 0, 0, '5m') === null, 'an unknown model yields no estimate rather than a wrong one');

  /* ── Checkpoint minimums ──────────────────────────────────────────────────────── */

  const sonnetMin = H.CACHE_MIN_TOKENS['claude-sonnet-4-6'];
  const haikuMin = H.CACHE_MIN_TOKENS['claude-haiku-4-5-20251001'];
  is(sonnetMin === 1024 && haikuMin === 4096, 'per-model checkpoint minimums match the Bedrock docs', `sonnet=${sonnetMin} haiku=${haikuMin}`);

  const marked = v => Array.isArray(v) && !!v[0].cache_control;
  const big = 'x'.repeat(40000), mid = 'x'.repeat(6000), small = 'x'.repeat(500);

  is(marked(H.cacheableSystem(big, 'claude-sonnet-4-6', '5m')), 'a large Sonnet prompt is marked cacheable');
  is(marked(H.cacheableSystem(mid, 'claude-sonnet-4-6', '5m')), 'a 6k char Sonnet prompt clears the 1024 token floor');
  is(!marked(H.cacheableSystem(small, 'claude-sonnet-4-6', '5m')), 'a tiny prompt is left as a plain string');

  /* The Haiku bug: 6k chars is ~1.7k tokens, far under Haiku's 4096 token floor, so the
     old 4096-CHARACTER threshold sent a checkpoint Bedrock then discarded. */
  is(!marked(H.cacheableSystem(mid, 'claude-haiku-4-5-20251001', '5m')),
     'a 6k char Haiku prompt is NOT marked: it cannot reach Haiku\'s 4096 token floor');
  is(marked(H.cacheableSystem(big, 'claude-haiku-4-5-20251001', '5m')), 'a 40k char Haiku prompt is marked');
  is(H.cacheableSystem('x'.repeat(5000), 'claude-haiku-4-5-20251001', '5m') === 'x'.repeat(5000),
     'the old 4096 char threshold no longer marks a sub-floor Haiku prompt');

  /* TTL plumbing. */
  const oneHour = H.cacheableSystem(big, 'claude-sonnet-4-6', '1h');
  is(oneHour[0].cache_control.ttl === '1h', 'a 1h call carries ttl inside cache_control');
  is(H.cacheableSystem(big, 'claude-sonnet-4-6', '5m')[0].cache_control.ttl === undefined,
     'a 5m call omits ttl entirely, which is the documented default');
  /* The 1h TTL was chosen from real traffic on the Netlify predecessor (calls ~26 min
     apart) and was silently dropped in the Bedrock port while the cost formula kept the 2x
     one-hour write multiplier. Both of those have to stay put together. */
  is(H.CACHE_TTL_DEFAULT === '1h', 'the clinical path defaults to the 1 hour cache window');
  is(H.cacheTtlFor('AI Scribe') === '1h' && H.cacheTtlFor('Letter Generator') === '1h' &&
     H.cacheTtlFor('Clinical Tool') === '1h', 'every clinical tool gets the hour by default');
  /* Two calls 26 minutes apart: 1h must actually be the cheaper of the two. */
  const twoCalls5m = H.estCostUsd('claude-sonnet-4-6', 0, 0, 10000, 0, '5m') * 2;
  const twoCalls1h = H.estCostUsd('claude-sonnet-4-6', 0, 0, 10000, 0, '1h') +
                     H.estCostUsd('claude-sonnet-4-6', 0, 0, 0, 10000, '1h');
  is(twoCalls1h < twoCalls5m, 'across a 26 minute gap the 1h window really is cheaper',
     `1h=${twoCalls1h.toFixed(5)} vs 5m=${twoCalls5m.toFixed(5)}`);
  is(H.cacheableSystem(big, 'not-a-model', '1h') === big, 'an unknown model is never marked cacheable');
  is(H.cacheableSystem('', 'claude-sonnet-4-6', '5m') === undefined && H.cacheableSystem(null, 'claude-sonnet-4-6', '5m') === undefined,
     'an empty system prompt yields no system block at all');
}

/* The two files are pasted into two separate Lambdas by hand, so they drift. */
console.log('\nDRIFT between the two deployed copies');
for (const sig of ['function estCostUsd(', 'function cacheableSystem(', 'function readUsage(', 'function newUsageAcc(', 'function cacheTtlFor(']) {
  const [x, y] = files.map(([, s]) => grab(s, sig));
  is(x === y, `${sig.replace('function ', '').replace('(', '')} is identical in both lambdas`);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
