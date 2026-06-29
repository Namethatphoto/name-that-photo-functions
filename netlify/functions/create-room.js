// Serverless function — creates one Daily.co room per call and returns its URL.
// The Daily.co API key lives ONLY here, as the Netlify environment variable DAILY_API_KEY
// (set in Netlify: Site settings > Environment variables). It is never present in any
// client-side file, so it can't be read by viewing source on the app.
//
// This function is hosted on Netlify, but the app itself is hosted on GoDaddy
// (namethatphoto.com) — that's fine, it's just called over the network cross-domain,
// which is why CORS headers are included below.
//
// Called once per device, the first time that device uses Live View (and again if the
// inspector taps "Generate new room"). Each call makes a brand-new, independent room, so
// two different inspectors' devices never end up sharing one.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.DAILY_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Server not configured: missing DAILY_API_KEY environment variable' }),
    };
  }

  const roomName = 'insp-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  try {
    const res = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: roomName,
        privacy: 'public',
        properties: {
          enable_chat: false,
          enable_screenshare: false,
          enable_recording: false,
          max_participants: 5,
          eject_at_room_exp: false,
        },
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: data.error || 'Daily.co room creation failed', detail: data }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: data.url }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
