// =============================================================
//  Supabase Auth gate for the whole dashboard (replaces lock.js).
//
//  Every page loads this synchronously in <head>, AFTER these two
//  (order matters — auth.js needs the config + the supabase lib):
//    <script src="/api/config"></script>
//    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//    <script src="auth.js"></script>
//
//  What it does:
//    • Hides the page immediately (same trick as lock.js) so no
//      content paints before the session check completes.
//    • Creates ONE shared Supabase client and exposes it as
//      window.DashAuth.client. Page scripts reuse it instead of
//      calling createClient again, so every REST + realtime call
//      carries the signed-in user's JWT — which is what lets the
//      RLS policies require the `authenticated` role.
//    • Valid session → reveal the page. No session → login.html
//      (with ?next= so you come back to the page you wanted).
//    • window.DashAuth.signOut()        — used by the topbar logout
//    • window.DashAuth.getAccessToken() — synchronous cached token
//      for keepalive fetch() calls in unload handlers, where async
//      APIs can't be awaited.
// =============================================================
(function () {
  'use strict';

  // Same config source + fallbacks as sync.js / topbar.js.
  var SUPABASE_URL = (window.DASH_SUPABASE_URL) || 'https://awytpwgorebhjewlqlhs.supabase.co';
  var SUPABASE_KEY = (window.DASH_SUPABASE_KEY) || 'sb_publishable_iyTy90Bi9Ct9ZMY0nu9hjA_N5BFmlFN';
  var LOGIN_PAGE = 'login.html';

  // ---- Hide the real page until the session check completes. ----------
  // Injected into <head> before <body> exists, so body content never
  // paints behind the gate (same guarantee lock.js gave).
  var GATE_CLASS = 'dash-authing';
  var docEl = document.documentElement;
  var style = document.createElement('style');
  style.id = '__dash_auth_style';
  style.textContent =
    'html.' + GATE_CLASS + ' { overflow: hidden !important; background: #050506; }' +
    'html.' + GATE_CLASS + ' body { display: none !important; }';
  docEl.classList.add(GATE_CLASS);
  (document.head || docEl).appendChild(style);

  function reveal() {
    docEl.classList.remove(GATE_CLASS);
    if (style.parentNode) style.parentNode.removeChild(style);
  }

  function loginUrl() {
    var here = (window.location.pathname.split('/').pop() || 'index.html') +
      window.location.search + window.location.hash;
    return LOGIN_PAGE + '?next=' + encodeURIComponent(here);
  }
  function toLogin() { window.location.replace(loginUrl()); }

  // ---- supabase-js missing (CDN unreachable)? Fail closed, visibly. ----
  if (!window.supabase || !window.supabase.createClient) {
    var overlay = document.createElement('div');
    overlay.id = '__dash_auth_err';
    overlay.setAttribute('style',
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
      'justify-content:center;padding:24px;background:#050506;color:#B8B6B0;' +
      'font-family:-apple-system,BlinkMacSystemFont,Inter,\'Segoe UI\',Roboto,sans-serif;' +
      'font-size:14px;text-align:center;');
    overlay.innerHTML =
      '<div>Could not load the sign-in library (offline?).<br><br>' +
      '<button onclick="location.reload()" style="padding:10px 18px;border:0;border-radius:10px;' +
      'cursor:pointer;background:#E8E5DD;color:#0A0A0B;font-weight:700;font-family:inherit;">' +
      'Retry</button></div>';
    docEl.appendChild(overlay);
    return;
  }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  var cachedToken = null;
  var sessionOk = false; // initial check passed at least once

  window.DashAuth = {
    client: client,
    url: SUPABASE_URL,
    key: SUPABASE_KEY,
    getAccessToken: function () { return cachedToken; },
    signOut: function () {
      var done = function () { window.location.replace(LOGIN_PAGE); };
      try { return client.auth.signOut().then(done, done); }
      catch (e) { done(); }
    },
  };

  client.auth.onAuthStateChange(function (event, session) {
    cachedToken = (session && session.access_token) || null;
    // Signed out in this tab or another (supabase-js relays the storage
    // event) → straight back to the login screen.
    if (event === 'SIGNED_OUT' && sessionOk) toLogin();
  });

  client.auth.getSession().then(function (res) {
    var session = res && res.data ? res.data.session : null;
    if (session) {
      cachedToken = session.access_token;
      sessionOk = true;
      reveal();
    } else {
      toLogin();
    }
  }, function () { toLogin(); });
})();
