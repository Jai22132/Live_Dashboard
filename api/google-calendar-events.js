// ============================================================
// GET /api/google-calendar-events?timeMin=<iso>&timeMax=<iso>
// The ONLY endpoint the browser talks to. It:
//   1. reads the stored refresh token from app_state
//   2. refreshes the access token if missing/expired
//   3. calls the Google Calendar API for the given day window
//   4. returns a minimal JSON list of events (time + title)
// No Google token is ever sent to the browser.
//
// Responses:
//   { connected: false }                → show "Connect" button
//   { connected: false, revoked: true } → token revoked, reconnect
//   { connected: true, events: [...] }  → render list
//   { connected: true, error: '...' }   → transient API error
// ============================================================
import {
  readAppState,
  writeAppState,
  refreshAccessToken,
  GOOGLE_TOKENS_KEY,
} from './_google-calendar.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const tokens = await readAppState(GOOGLE_TOKENS_KEY);
    if (!tokens || !tokens.refresh_token) {
      return res.status(200).json({ connected: false });
    }

    // Reuse the cached access token until ~1 min before it expires.
    let accessToken = tokens.access_token;
    const stillValid = accessToken && tokens.expires_at && Date.now() < tokens.expires_at - 60000;
    if (!stillValid) {
      try {
        const refreshed = await refreshAccessToken(tokens.refresh_token);
        accessToken = refreshed.access_token;
        await writeAppState(GOOGLE_TOKENS_KEY, {
          refresh_token: tokens.refresh_token,
          access_token: accessToken,
          expires_at: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : 0,
        });
      } catch (e) {
        // invalid_grant / unauthorized → the user revoked access.
        if (e.status === 400 || e.status === 401) {
          return res.status(200).json({ connected: false, revoked: true });
        }
        throw e;
      }
    }

    const { timeMin, timeMax } = dayWindow(req.query || {});
    const url =
      'https://www.googleapis.com/calendar/v3/calendars/primary/events' +
      '?singleEvents=true&orderBy=startTime&maxResults=50' +
      '&timeMin=' + encodeURIComponent(timeMin) +
      '&timeMax=' + encodeURIComponent(timeMax);

    const gRes = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (gRes.status === 401) {
      // Access token rejected mid-flight — treat as needing reconnect.
      return res.status(200).json({ connected: false, revoked: true });
    }
    if (!gRes.ok) {
      return res.status(200).json({ connected: true, error: 'calendar_fetch_failed' });
    }

    const data = await gRes.json();
    const events = (data.items || []).map(ev => {
      const allDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
      return {
        title: ev.summary || '(no title)',
        start: (ev.start && (ev.start.dateTime || ev.start.date)) || null,
        allDay,
      };
    });

    return res.status(200).json({ connected: true, events });
  } catch (e) {
    return res.status(200).json({ connected: true, error: 'server_error' });
  }
}

// Use the client-supplied local-day window when it's well-formed,
// otherwise fall back to a UTC day so the endpoint still works.
function dayWindow(query) {
  if (ISO.test(query.timeMin || '') && ISO.test(query.timeMax || '')) {
    return { timeMin: query.timeMin, timeMax: query.timeMax };
  }
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}
