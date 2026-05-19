// theme-toggle.js
// Shared light/dark mode toggle for all Think Beyond Practice products.
// Reads/writes localStorage('tbp_theme'). Persists across all products on the same domain.
// Usage: Include this script on any page. It auto-injects the toggle button and applies the saved theme.

(function() {
  var STORAGE_KEY = 'tbp_theme';
  var LIGHT_CLASS = 'light-mode';

  // Apply saved theme immediately (before DOM paints)
  var saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch(e) {}
  if (saved === 'light') document.documentElement.classList.add(LIGHT_CLASS);

  function toggle() {
    var isLight = document.documentElement.classList.toggle(LIGHT_CLASS);
    try { localStorage.setItem(STORAGE_KEY, isLight ? 'light' : 'dark'); } catch(e) {}
    updateIcon(isLight);
  }

  function updateIcon(isLight) {
    var btn = document.getElementById('tbp-theme-toggle');
    if (btn) btn.innerHTML = isLight ? '&#x1F319;' : '&#x2600;';
    if (btn) btn.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
  }

  function inject() {
    if (document.getElementById('tbp-theme-toggle')) return;
    var btn = document.createElement('button');
    btn.id = 'tbp-theme-toggle';
    btn.onclick = toggle;
    btn.setAttribute('aria-label', 'Toggle light/dark mode');
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      width: '42px',
      height: '42px',
      borderRadius: '50%',
      border: '1px solid rgba(42,171,184,0.3)',
      background: 'rgba(17,28,48,0.9)',
      color: '#e8e2d6',
      fontSize: '18px',
      cursor: 'pointer',
      zIndex: '100',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'all 0.2s',
      backdropFilter: 'blur(8px)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
    });
    document.body.appendChild(btn);
    updateIcon(document.documentElement.classList.contains(LIGHT_CLASS));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
