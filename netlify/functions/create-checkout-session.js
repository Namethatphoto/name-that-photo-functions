// Serverless function — creates a Stripe Checkout Session for the $17.99/mo subscription
// with a 2-day free trial (card collected upfront, auto-charges when the trial ends).
//
// STRIPE_SECRET_KEY and STRIPE_PRICE_ID live ONLY as Netlify environment variables
// (Site settings > Environment variables) — never in any client-side file. Calling the
// Stripe REST API directly via fetch (no `stripe` npm package) keeps this consistent with
// create-room.js, and avoids needing a package.json/node_modules for this functions folder.
//
// Hosted on Netlify; the app itself is hosted on GoDaddy (namethatphoto.com) — CORS headers
// below allow that cross-origin call.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SUCCESS_URL = 'https://namethatphoto.com/?checkout=success&session_id={CHECKOUT_SESSION_ID}';
const CANCEL_URL = 'https://namethatphoto.com/?checkout=cancel';

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!secretKey || !priceId) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Server not configured: missing STRIPE_SECRET_KEY or STRIPE_PRICE_ID' }),
    };
  }

  let uid, email;
  try {
    const parsed = JSON.parse(event.body || '{}');
    uid = parsed.uid;
    email = parsed.email;
  } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  if (!uid) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing uid' }) };
  }

  // client_reference_id carries the Firebase uid through to the webhook (task #63), which is
  // how the webhook knows which Firestore users/{uid} doc to flip to "trial"/"active".
  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('subscription_data[trial_period_days]', '2');
  // Forces card collection upfront even though there's a trial — required per the
  // "card upfront, auto-charges after 2 days" decision (no trial without a payment method).
  params.append('payment_method_collection', 'always');
  params.append('client_reference_id', uid);
  params.append('success_url', SUCCESS_URL);
  params.append('cancel_url', CANCEL_URL);
  if (email) params.append('customer_email', email);

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: data.error ? data.error.message : 'Stripe Checkout session creation failed' }),
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
