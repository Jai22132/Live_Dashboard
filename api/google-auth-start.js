// ============================================================
// GET /api/google-auth-start
// Redirects the browser to Google's OAuth consent screen.
// Uses GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI (server-side env
// vars). The client secret is NOT needed here and is never sent.
//
// A random `state` is stored in an HttpOnly cookie and echoed back
// on the callback to defend against CSRF.
// ============================================================
import crypto from 'node:crypto';

// calendar.readonly → day-agenda widget (Calendar module)
// drive.appdata     → Finance module reads the Cashew backup file
//                     that the Cashew app stores in the hidden
//                     appDataFolder of this same Google account.
const SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly' +
  ' https://www.googleapis.com/auth/drive.appdata';

export default function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    res.status(500).send('Google Calendar is not configured on the server.');
    return;
  }

  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',        // ask for a refresh token
    prompt: 'consent',             // force a refresh token even on re-connect
    include_granted_scopes: 'true',
    state,
  });

  // HttpOnly + SameSite=Lax so the cookie survives the top-level
  // redirect back from Google but is unreadable to page scripts.
  res.setHeader(
    'Set-Cookie',
    'g_oauth_state=' + state + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600'
  );
  res.writeHead(302, {
    Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString(),
  });
  res.end();
}
