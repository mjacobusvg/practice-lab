window.TBP_DEMO = false;
window.TBPAuth = {
  protect: function(opts){
    window.__tbpVerifiedCalled = true;
    try { opts.onVerified(); }
    catch (e) { window.__tbpVerifyThrow = (e && (e.stack || e.message)) || String(e); throw e; }
  }
};
