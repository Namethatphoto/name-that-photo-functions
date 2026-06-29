// Serverless function — Stripe calls this whenever a subscription-relevant event happens
// (checkout completed, subscription renewed/canceled). This is the ONLY thing allowed to
// write users/{uid}.status in Firestore — client code can read its own doc but never write
// status/betaAccess (see firestore.rules), so a user can't fake their own subscription via
// dev tools. That's the whole point of doing this server-side.
//
// No npm packages used (no `stripe`, no `firebase-admin`) — consistent with create-room.js
// and create-checkout-session.js, and necessary because this site deploys via manual
// drag-and-drop (no build step to run `npm install`). Stripe signature verification is done
// by hand with Node's built-in crypto; Firestore writes go through a hand-rolled Google
// service-account JWT -> OAuth token -> Firestore REST API call.
//
// Required Netlify environment variables:
//   STRIPE_WEBHOOK_SECRET   - from Stripe Dashboard > Developers > Webhooks > (this endpoint) > Signing secret
//   FIREBASE_PROJECT_ID     - "project_id" field from the downloaded service account JSON
//   FIREBASE_CLIENT_EMAIL   - "client_email" field from that same JSON
//   FIREBASE_PRIVATE_KEY    - "private_key" field from that same JSON, pasted exactly as-is
//                             (it contains literal \n sequences — that's expected, handled below)

const crypto = require('crypto');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; })
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  // Constant-time-ish compare via Node's built-in helper.
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch (e) {
    return false; // length mismatch etc. — not a valid signature
  }
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

async function patchUserDoc(uid, fields) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const accessToken = await getFirestoreAccessToken();
  const fieldNames = Object.keys(fields);
  const mask = fieldNames.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}?${mask}&currentDocument.exists=true`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error('Firestore update failed: ' + (data.error ? data.error.message : res.status));
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return { statusCode: 500, body: 'Server not configured: missing STRIPE_WEBHOOK_SECRET' };
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  if (!verifyStripeSignature(rawBody, sigHeader, secret)) {
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const uid = session.client_reference_id;
        if (uid) {
          await patchUserDoc(uid, {
            status: { stringValue: 'trial' },
            stripeCustomerId: { stringValue: session.customer || '' },
            stripeSubscriptionId: { stringValue: session.subscription || '' },
          });
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const uid = sub.metadata && sub.metadata.uid;
        // Stripe subscription statuses: trialing, active, past_due, canceled, unpaid, incomplete, incomplete_expired
        const mapped = sub.status === 'trialing' ? 'trial'
          : (sub.status === 'active' ? 'active' : sub.status);
        if (uid) {
          await patchUserDoc(uid, { status: { stringValue: mapped } });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        const uid = sub.metadata && sub.metadata.uid;
        if (uid) {
          await patchUserDoc(uid, { status: { stringValue: 'canceled' } });
        }
        break;
      }
      default:
        break; // ignore events we don't care about
    }
  } catch (err) {
    // Returning 500 makes Stripe retry the webhook automatically.
    return { statusCode: 500, body: 'Webhook handler error: ' + err.message };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
