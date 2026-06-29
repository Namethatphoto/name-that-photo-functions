// Serverless function — reads a policy declarations page or repair estimate PDF and pulls
// out the handful of fields the Photo Report Options form needs, so the adjuster doesn't
// have to retype/redictate them from the source document.
//
// ANTHROPIC_API_KEY lives ONLY as a Netlify environment variable (Site settings >
// Environment variables) — never in any client-side file. Calling the Anthropic REST API
// directly via fetch (no SDK) keeps this consistent with create-checkout-session.js and
// create-room.js, and avoids needing a package.json/node_modules for this functions folder.
//
// Hosted on Netlify; the app itself is hosted on GoDaddy (namethatphoto.com) — CORS headers
// below allow that cross-origin call.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Haiku is plenty for reading typed/printed declarations pages and estimates — this is a
// one-off, low-volume call (once or twice per claim, not per photo), so cost isn't the
// driver here; keeping the model light keeps the response fast.
const MODEL = 'claude-haiku-4-5-20251001';

const FIELD_SCHEMA = `{
  "policyHolderName": string or null,
  "claimNumber": string or null,
  "policyNumber": string or null,
  "propertyAddress": string or null,   // street address only, no city/state/zip
  "city": string or null,
  "state": string or null,             // 2-letter abbreviation if shown
  "zip": string or null,
  "ownerPhone": string or null
}`;

const PROMPT = `You are reading an insurance policy declarations page or repair estimate. Extract only what is explicitly printed in the document — do not guess, infer, or fill in anything that isn't directly stated.

Return ONLY a single JSON object with this exact shape, no other text:
${FIELD_SCHEMA}

Rules:
- If a field isn't present in the document, use null for it — never invent a value.
- "policyHolderName" is the named insured / policyholder, not the carrier or adjuster.
- Many declarations pages print the name "Last, First" or "LAST FIRST MI" (surname first). Always normalize "policyHolderName" to "First Last" order in the output, regardless of how it's printed in the document. Do not reorder or guess if the document already shows it as "First Last" or if you can't tell which part is the surname.
- If two names are listed (joint policyholders, e.g. "Smith, John & Jane"), use only the first-listed name in "First Last" order.
- "ownerPhone" is the policyholder's phone number, not a claims department line.
- "claimNumber" and "policyNumber" are two different values printed separately on most declarations pages and estimates (commonly labeled "Claim #"/"Claim Number" vs. "Policy #"/"Policy Number"). Extract each independently — never copy one into the other, and never assume a document only has one or the other.
- Strip labels and extra punctuation — just the value itself.`;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Server not configured: missing ANTHROPIC_API_KEY' }),
    };
  }

  let pdfBase64;
  try {
    const parsed = JSON.parse(event.body || '{}');
    pdfBase64 = parsed.pdfBase64;
  } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  if (!pdfBase64) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing pdfBase64' }) };
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: data.error ? data.error.message : 'Document extraction failed' }),
      };
    }

    const text = (data.content || []).map((b) => b.text || '').join('').trim();
    // Model is asked to return JSON only, but strip any stray code-fence wrapping just in case.
    const cleaned = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim();

    let fields;
    try {
      fields = JSON.parse(cleaned);
    } catch (parseErr) {
      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Could not parse extracted data from the document' }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
