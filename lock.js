// =============================================================
//  Passcode lock screen for the whole dashboard.
//
//  Every page loads this as the FIRST <script> in <head> with no
//  `defer`, so it runs synchronously *before* the page body is
//  parsed or painted. That means the gate is enforced no matter
//  which page you open directly (index.html, finance.html, …) —
//  you can't skip it by deep-linking to an inner page.
//
//  How it works:
//    • Checks a per-session flag (sessionStorage). If you've
//      already unlocked in this browser session, it returns
//      immediately and the page loads normally.
//    • Otherwise it hides the real page and shows a lock screen.
//      Enter the password → the flag is set → the page reloads
//      and renders unlocked.
//
//  Change the password below.
// =============================================================
(function () {
  'use strict';

  var PASSWORD = "Jaime@2026";       // ← the dashboard password
  var FLAG_KEY = "dash_unlocked_v1"; // sessionStorage flag (per browser session)

  // ---- Already unlocked this session? Let the page load untouched. ----
  try {
    if (sessionStorage.getItem(FLAG_KEY) === "1") return;
  } catch (e) {
    // sessionStorage blocked (private mode edge cases) — fall through and
    // still show the gate; the page just won't remember across navigations.
  }

  // ---- Hide the real page until unlocked. -------------------------------
  // Injected into <head> before <body> exists, so body content never paints
  // behind the lock screen.
  var LOCK_CLASS = "dash-locked";
  var style = document.createElement("style");
  style.id = "__dash_lock_style";
  style.textContent =
    "html." + LOCK_CLASS + " { overflow: hidden !important; }" +
    "html." + LOCK_CLASS + " body { display: none !important; }" +
    "#__dash_lock {" +
    "  position: fixed; inset: 0; z-index: 2147483647;" +
    "  display: flex; align-items: center; justify-content: center;" +
    "  padding: 24px; background: #050506;" +
    "  font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;" +
    "  -webkit-font-smoothing: antialiased;" +
    "}" +
    "#__dash_lock::before {" +
    "  content: ''; position: absolute; inset: 0; pointer-events: none;" +
    "  background:" +
    "    radial-gradient(circle at 82% 14%, rgba(224,118,88,0.16), transparent 45%)," +
    "    radial-gradient(circle at 18% 90%, rgba(180,180,200,0.06), transparent 50%);" +
    "  filter: blur(40px);" +
    "}" +
    ".__dash_lock_card {" +
    "  position: relative; width: 100%; max-width: 340px;" +
    "  background: rgba(255,255,255,0.04);" +
    "  border: 1px solid rgba(255,255,255,0.07);" +
    "  border-radius: 18px; padding: 28px 24px;" +
    "  box-shadow: 0 24px 70px rgba(0,0,0,0.6);" +
    "  backdrop-filter: blur(24px) saturate(1.2);" +
    "  -webkit-backdrop-filter: blur(24px) saturate(1.2);" +
    "  text-align: center;" +
    "}" +
    ".__dash_lock_icon { font-size: 34px; line-height: 1; margin-bottom: 12px; }" +
    ".__dash_lock_title {" +
    "  margin: 0 0 4px; font-size: 19px; font-weight: 700; letter-spacing: -0.02em;" +
    "  color: #FAFAFA;" +
    "}" +
    ".__dash_lock_sub { margin: 0 0 20px; font-size: 12.5px; color: #76746E; }" +
    ".__dash_lock_input {" +
    "  width: 100%; padding: 12px 14px; margin-bottom: 12px;" +
    "  border: 1px solid rgba(255,255,255,0.10); border-radius: 12px;" +
    "  background: rgba(0,0,0,0.30); color: #FAFAFA;" +
    "  font-family: inherit; font-size: 15px; outline: none; text-align: center;" +
    "  color-scheme: dark; transition: border-color 0.2s, background 0.2s;" +
    "}" +
    ".__dash_lock_input:focus { border-color: rgba(255,255,255,0.30); background: rgba(0,0,0,0.40); }" +
    ".__dash_lock_input.err { border-color: #FF6B6B; animation: __dash_shake 0.32s; }" +
    "@keyframes __dash_shake {" +
    "  0%,100%{transform:translateX(0)} 20%{transform:translateX(-7px)}" +
    "  40%{transform:translateX(6px)} 60%{transform:translateX(-4px)} 80%{transform:translateX(3px)}" +
    "}" +
    ".__dash_lock_btn {" +
    "  width: 100%; padding: 12px 16px; border: 0; border-radius: 12px; cursor: pointer;" +
    "  background: linear-gradient(180deg, #FFFFFF 0%, #E8E5DD 100%); color: #0A0A0B;" +
    "  font-family: inherit; font-size: 14px; font-weight: 700;" +
    "  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 2px 8px rgba(0,0,0,0.35);" +
    "  transition: filter 0.15s, transform 0.1s;" +
    "}" +
    ".__dash_lock_btn:hover { filter: brightness(1.05); }" +
    ".__dash_lock_btn:active { transform: translateY(1px); }" +
    ".__dash_lock_msg { min-height: 16px; margin-top: 10px; font-size: 12px; color: #FF6B6B; }";

  var docEl = document.documentElement;
  docEl.classList.add(LOCK_CLASS);
  (document.head || docEl).appendChild(style);

  // ---- Build the lock screen. Appended to <html> (not <body>, which is
  //      hidden) so it's visible while the rest of the page stays gated. ----
  var overlay = document.createElement("div");
  overlay.id = "__dash_lock";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Locked — password required");
  overlay.innerHTML =
    '<div class="__dash_lock_card">' +
    '  <div class="__dash_lock_icon">🔒</div>' +
    '  <h1 class="__dash_lock_title">Dashboard locked</h1>' +
    '  <p class="__dash_lock_sub">Enter the password to continue.</p>' +
    '  <input class="__dash_lock_input" id="__dash_lock_input" type="password" ' +
    '         placeholder="Password" autocomplete="current-password" ' +
    '         autocapitalize="off" autocorrect="off" spellcheck="false" ' +
    '         aria-label="Password">' +
    '  <button class="__dash_lock_btn" id="__dash_lock_btn" type="button">Unlock</button>' +
    '  <div class="__dash_lock_msg" id="__dash_lock_msg" role="alert"></div>' +
    '</div>';
  docEl.appendChild(overlay);

  function unlock() {
    try { sessionStorage.setItem(FLAG_KEY, "1"); } catch (e) {}
    // Reload so the page initializes cleanly in its unlocked state, rather
    // than trying to reveal a body that scripts already ran against.
    window.location.reload();
  }

  function wire() {
    var input = document.getElementById("__dash_lock_input");
    var btn = document.getElementById("__dash_lock_btn");
    var msg = document.getElementById("__dash_lock_msg");
    if (!input || !btn) return;

    function attempt() {
      if (input.value === PASSWORD) {
        msg.textContent = "";
        unlock();
        return;
      }
      // Wrong password — flag the field, show a message, clear + refocus.
      input.classList.remove("err");
      // reflow so the shake animation re-triggers on repeated wrong tries
      void input.offsetWidth;
      input.classList.add("err");
      msg.textContent = "Incorrect password.";
      input.value = "";
      input.focus();
    }

    btn.addEventListener("click", attempt);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); attempt(); }
    });
    input.addEventListener("input", function () {
      input.classList.remove("err");
      msg.textContent = "";
    });

    // Autofocus the field as soon as we can.
    try { input.focus(); } catch (e) {}
  }

  // The input exists now (we just built it), so we can wire immediately.
  // Also re-focus once the document is fully ready, in case the browser
  // stole focus during initial parse.
  wire();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      var input = document.getElementById("__dash_lock_input");
      if (input) { try { input.focus(); } catch (e) {} }
    }, { once: true });
  }
})();
