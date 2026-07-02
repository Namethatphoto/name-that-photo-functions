// Saves the user's company/inspector profile to Firestore using admin credentials,
// bypassing client-side security rules. Called by the app whenever the user clicks
// "Save to Profile" — ensures data survives cache clears and is available on any device.
//
// Reuses the same environment variables and helper pattern as admin-set-beta.js:
//   FIREBASE_WEB_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

const crypto = require('crypto');

const FIREBASE_WEB_API_KEY = 'AIzaSyBbN5GQiUxx6EmPOBlqw-rpVrXq9_UI8v0';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verifyIdToken(idToken) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const data = await res.json();
  if (!res.ok || !data.users || !data.users[0]) throw new Error('Invalid or expired session — sign in again.');
  return data.users[0];
}

async function getFirestoreAccessToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = base64url(Buffer.from(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })));
  const signInput = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput);
  signer.end();
  const signature = base64url(signer.sign(privateKey));
  const jwt = `${signInput}.${signature}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Firebase auth failed: ' + (data.error_description || JSON.stringify(data)));
  return data.access_token;
}

// Convert a plain JS object to Firestore REST field format.
// logoDataUrl is excluded — it can be large and is kept in local storage only.
function toFirestoreFields(obj) {
  const SKIP = new Set(['logoDataUrl']);
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP.has(k)) continue;
    if (v === null || v === undefined) {
      fields[k] = { nullValue: null };
    } else if (typeof v === 'boolean') {
      fields[k] = { booleanValue: v };
    } else if (typeof v === 'number') {
      fields[k] = { doubleValue: v };
    } else {
      fields[k] = { stringValue: String(v) };
    }
  }
  // Always mark profile as complete when saved.
  fields.setupComplete = { booleanValue: true };
  return fields;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };

  let idToken, profile;
  try {
    const parsed = JSON.parse(event.body || '{}');
    idToken = parsed.idToken;
    profile = parsed.profile || {};
  } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  if (!idToken) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing idToken' }) };

  try {
    const user = await verifyIdToken(idToken);
    const uid = user.localId;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const accessToken = await getFirestoreAccessToken();

    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}/profile/company`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: toFirestoreFields(profile) }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error('Firestore write failed: ' + (data.error ? data.error.message : res.status));
    }

    return { statusCode: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
