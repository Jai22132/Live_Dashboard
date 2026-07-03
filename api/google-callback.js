// ============================================================
// GET /api/google-callback?code=...&state=...
// Google redirects here after consent. We exchange the auth code
// for tokens using GOOGLE_CLIENT_SECRET (server-side only), then
// store them in the shared app_state table under 'google_calendar_tokens'.
// The browser never sees any Google token.
// ============================================================
import {
  exchangeCodeForTokens,
  readAppState,
  writeAppState,
  GOOGLE_TOKENS_KEY,
} from './_google-calendar.js';

export default async function handler(req, res) {
  const q = req.query || {};

  if (q.error) {
    return finish(res, 'Google authorization was cancelled. You can close this tab and try again.');
  }
  if (!q.code) {
    return finish(res, 'Missing authorization code.');
  }

  // CSRF: the state we set in the cookie must match what Google echoed back.
  const cookieState = (req.cookies && req.cookies.g_oauth_state) || parseCookie(req.headers.cookie, 'g_oauth_state');
  if (!q.state || !cookieState || q.state !== cookieState) {
    return finish(res, 'Invalid OAuth state. Please start the connection again.');
  }

  try {
    const tokens = await exchangeCodeForTokens(q.code);

    // Google only returns a refresh_token on the first consent. If it's
    // missing (a re-connect), keep the one we already stored.
    let refresh = tokens.refresh_token;
    if (!refresh) {
      const existing = await readAppState(GOOGLE_TOKENS_KEY);
      refresh = existing && existing.refresh_token;
    }

    await writeAppState(GOOGLE_TOKENS_KEY, {
      refresh_token: refresh || null,
      access_token: tokens.access_token || null,
      expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0,
    });

    // Clear the state cookie and bounce back to the dashboard.
    res.setHeader('Set-Cookie', 'g_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    res.writeHead(302, { Location: '/main.html?calendar=connected' });
    res.end();
  } catch (e) {
    finish(res, 'Could not connect Google Calendar. Please try again.');
  }
}

function finish(res, message) {
  res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    '<!doctype html><meta charset="utf-8">' +
    '<body style="font-family:-apple-system,sans-serif;background:#050506;color:#B8B6B0;padding:40px;text-align:center">' +
    '<p>' + escapeHtml(message) + '</p>' +
    '<p><a style="color:#6BE3A4" href="/main.html">Back to dashboard</a></p>'
  );
}

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.split(';').map(s => s.trim()).find(c => c.indexOf(name + '=') === 0);
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
