// POST { phone, amount, reference } with header Authorization: Bearer <supabase user jwt>
const BASE = process.env.MPESA_ENV === 'sandbox'
  ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
const SB = process.env.SUPABASE_URL;
const json = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function normalizePhone(p) {
  p = String(p).replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(p)) p = '254' + p.slice(1);
  if (/^[17]\d{8}$/.test(p)) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  // 1. Only logged-in POS users may trigger a push
  const auth = event.headers.authorization || '';
  const u = await fetch(`${SB}/auth/v1/user`, { headers: { Authorization: auth, apikey: process.env.SUPABASE_ANON_KEY } });
  if (!u.ok) return json(401, { error: 'Not signed in' });
  const user = await u.json();

  // 2. Validate input
  let b; try { b = JSON.parse(event.body); } catch { return json(400, { error: 'Bad JSON' }); }
  const phone = normalizePhone(b.phone);
  const amount = Math.round(Number(b.amount));
  if (!phone) return json(400, { error: 'Invalid phone number' });
  if (!(amount >= 1)) return json(400, { error: 'Invalid amount' });

  try {
    // 3. Daraja token
    const basic = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    const t = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` } });
    const { access_token } = await t.json();
    if (!access_token) return json(502, { error: 'Could not get M-Pesa token' });

    // 4. STK push
    const shortcode = process.env.MPESA_SHORTCODE;
    const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const password = Buffer.from(shortcode + process.env.MPESA_PASSKEY + timestamp).toString('base64');
    const isTill = process.env.MPESA_TYPE === 'till';
    const res = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: isTill ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: process.env.MPESA_PARTYB || shortcode, // Till number if using a Till
        PhoneNumber: phone,
        CallBackURL: process.env.MPESA_CALLBACK_URL,
        AccountReference: String(b.reference || 'SwitchEnergy').slice(0, 12),
        TransactionDesc: 'Switch Energy sale'
      })
    });
    const d = await res.json();
    if (d.ResponseCode !== '0') return json(502, { error: d.errorMessage || d.ResponseDescription || 'STK push failed' });

    // 5. Record as pending; callback will update it
    await fetch(`${SB}/rest/v1/payments`, {
      method: 'POST',
      headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkout_request_id: d.CheckoutRequestID, merchant_request_id: d.MerchantRequestID, phone, amount, reference: b.reference || null, status: 'pending', created_by: user.id })
    });
    return json(200, { checkoutRequestId: d.CheckoutRequestID });
  } catch (e) {
    return json(500, { error: 'Server error' });
  }
};
