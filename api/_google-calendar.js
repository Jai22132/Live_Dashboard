// ============================================================
// SERVER-SIDE ONLY. Never imported by browser code.
// Shared helpers for the Google Calendar widget:
//   - read/write the Google OAuth tokens in the shared app_state
//     table (same table + upsert pattern as sync.js)
//   - exchange an auth code for tokens / refresh an access token
//
// This file lives under /api and is prefixed with "_" so Vercel
// treats it as a private helper module, not a public route. The
// GOOGLE_CLIENT_SECRET only ever appears in files under /api.
// ============================================================

// The single app_state row key the tokens live under. The browser
// never reads this key — it only talks to /api/google-calendar-events.
export const GOOGLE_TOKENS_KEY = 'google_calendar_tokens';

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  // Prefer the service-role (secret) key: it bypasses RLS, which is required
  // once app_state's policies demand the `authenticated` role — server code
  // has no user session. Falls back to the anon key so nothing breaks before
  // SUPABASE_SERVICE_ROLE_KEY is added to the Vercel env.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase env vars are not configured');
  return { url, key };
}

// Read one row's `data` from public.app_state via the Supabase REST API
// (mirrors the flush pattern used client-side in sync.js).
export async function readAppState(rowKey) {
  const { url, key } = supabaseConfig();
  const res = await fetch(
    url + '/rest/v1/app_state?select=data&key=eq.' + encodeURIComponent(rowKey),
    { headers: { apikey: key, Authorization: 'Bearer ' + key } }
  );
  if (!res.ok) throw new Error('Supabase read failed: ' + res.status);
  const rows = await res.json();
  return rows && rows[0] ? rows[0].data : null;
}

// Upsert one row's `data` into public.app_state (same shape sync.js writes).
export async function writeAppState(rowKey, data) {
  const { url, key } = supabaseConfig();
  const res = await fetch(url + '/rest/v1/app_state?on_conflict=key', {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key: rowKey, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error('Supabase write failed: ' + res.status);
}

// Exchange an OAuth authorization code for access + refresh tokens.
export async function exchangeCodeForTokens(code) {
  return postToken({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
}

// Use a stored refresh token to mint a fresh access token.
export async function refreshAccessToken(refreshToken) {
  return postToken({
    refresh_token: refreshToken,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
}

async function postToken(fields) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('Google token request failed: ' + res.status);
    err.status = res.status;   // 400 invalid_grant → token revoked/expired
    err.body = text;
    throw err;
  }
  return JSON.parse(text);
}
