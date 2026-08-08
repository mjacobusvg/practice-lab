// netlify/functions/_lib/unlocks.js
//
// Shared check for the "one free unlock per calendar month" grant (D). Returns
// true when the given account has a recorded unlock for the given post, so the
// comment / reaction / members-extra endpoints can all treat an unlocked post
// the same way a free_visible one is treated for that member. Fails closed.

async function hasUnlock(supabaseUrl, serviceKey, accountId, postId) {
  if (!supabaseUrl || !serviceKey || !accountId || !postId) return false;
  try {
    const res = await fetch(
      supabaseUrl + '/rest/v1/post_unlocks?account_id=eq.' + encodeURIComponent(accountId) +
      '&post_id=eq.' + encodeURIComponent(postId) + '&select=id&limit=1',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return !!(rows && rows.length);
  } catch (e) {
    return false;
  }
}

module.exports = { hasUnlock };
