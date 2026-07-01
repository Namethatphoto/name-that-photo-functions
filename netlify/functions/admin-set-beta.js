// Serverless function — flips users/{uid}.betaAccess for power-user testers who shouldn't
// have to pay. This is the ONLY place that's allowed to write betaAccess (Firestore rules
// deny client writes to that field — see firestore.rules), and it independently re-verifies
// the caller's identity itself rather than trusting the client UI. That means even if
// someone finds the hidden admin screen in the page source, they still can't grant
// themselves access without an ID token from an email on the ADMIN_EMAILS allowlist.
//
// No npm packages used — consistent with the other functions in this folder, and necessary
// since this site deploys via manual drag-and-drop (no build step to run `npm install`).
//
// Required Netlify environment variables (FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY are
// already set from task #63 — this function reuses them):
//   ADMIN_EMAILS         - comma-separated allowlist, e.g. "namethatphoto@gmail.com"
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY  - service account creds

const crypto = require('crypto');

// Firebase Web API key — same public key already embedded in index.html's firebaseConfig.
// Not a secret (Firebase web API keys are restricted by Auth/Firestore rules, not by
// secrecy), so it's fine to hardcode here rather than add yet another env var.
const FIREBASE_WEB_API_KEY = 'AIzaSyBbN5GQiUxx6EmPOBlqw-rpVrXq9_UI8v0';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Confirms the ID token is genuinely valid (signed by Firebase, not expired/forged) by
// asking Google's own Identity Toolkit to look it up — avoids needing a JWT-verification
// library just to check a signature ourselves.
async function verifyIdToken(idToken) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const data = await res.json();
  if (!res.ok || !data.users || !data.users[0]) throw new Error('Invalid or expired session — sign in again.');
  return data.users[0]; // { localId, email, ... }
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
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Firebase auth failed: ' + (data.error_description || JSON.stringify(data)));
  return data.access_token;
}

// Firestore has no "find by field" lookup outside of a structured query — this runs
// `where email == targetEmail limit 1` against the users collection.
async function findUidByEmail(projectId, accessToken, email) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'users' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'email' },
          op: 'EQUAL',
          value: { stringValue: email },
        },
      },
      limit: 1,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const rows = await res.json();
  if (!res.ok) throw new Error('Firestore query failed');
  const match = Array.isArray(rows) ? rows.find((r) => r.document) : null;
  if (!match) return null;
  // document.name is the full path; the uid is the last path segment.
  const parts = match.document.name.split('/');
  return parts[parts.length - 1];
}

async function patchBetaAccess(projectId, accessToken, uid, betaAccess) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=betaAccess&currentDocument.exists=true`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { betaAccess: { booleanValue: !!betaAccess } } }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error('Firestore update failed: ' + (data.error ? data.error.message : res.status));
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  let idToken, targetEmail, betaAccess;
  try {
    const parsed = JSON.parse(event.body || '{}');
    idToken = parsed.idToken;
    targetEmail = (parsed.targetEmail || '').trim().toLowerCase();
    betaAccess = !!parsed.betaAccess;
  } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  if (!idToken || !targetEmail) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing idToken or targetEmail' }) };
  }

  try {
    const caller = await verifyIdToken(idToken);
    const allowlist = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!caller.email || !allowlist.includes(caller.email.toLowerCase())) {
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: `Not authorized as admin. Signed in as: "${caller.email || 'unknown'}" — allowlist has ${allowlist.length} entry/entries. Check that ADMIN_EMAILS in Netlify matches exactly (no quotes, no spaces).`
        })
      };
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const accessToken = await getFirestoreAccessToken();
    const uid = await findUidByEmail(projectId, accessToken, targetEmail);
    if (!uid) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No account found for that email.' }) };
    }
    await patchBetaAccess(projectId, accessToken, uid, betaAccess);

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, uid, betaAccess }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
