// Serverless function — creates a Stripe Billing Portal session so a subscriber can update
// their card or cancel without emailing support (task #66).
//
// Security note: this does NOT take a Stripe customer ID from the client. A client-supplied
// customer ID would let anyone manage someone else's subscription just by guessing/sending a
// different ID. Instead it verifies the caller's Firebase ID token (same approach as
// admin-set-beta.js), looks up THEIR OWN stripeCustomerId server-side from Firestore, and
// only ever opens a portal session for that customer.
//
// Required Netlify environment variables (all already set from tasks #62/#63):
//   STRIPE_SECRET_KEY, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

const crypto = require('crypto');

const FIREBASE_WEB_API_KEY = 'AIzaSyBbN5GQiUxx6EmPOBlqw-rpVrXq9_UI8v0';
const RETURN_URL = 'https://namethatphoto.com/app';

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

async function getUserDoc(projectId, accessToken, uid) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return null;
  const data = await res.json();
  if (!res.ok) throw new Error('Firestore read failed');
  return data.fields || null;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Server not configured: missing STRIPE_SECRET_KEY' }) };
  }

  let idToken;
  try {
    idToken = JSON.parse(event.body || '{}').idToken;
  } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  if (!idToken) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing idToken' }) };
  }

  try {
    const caller = await verifyIdToken(idToken);
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const accessToken = await getFirestoreAccessToken();
    const fields = await getUserDoc(projectId, accessToken, caller.localId);
    const customerId = fields && fields.stripeCustomerId && fields.stripeCustomerId.stringValue;

    if (!customerId) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No subscription found for this account.' }) };
    }

    const params = new URLSearchParams();
    params.append('customer', customerId);
    params.append('return_url', RETURN_URL);

    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, headers: CORS_HEADERS, body: JSON.stringify({ error: data.error ? data.error.message : 'Could not create billing portal session' }) };
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
