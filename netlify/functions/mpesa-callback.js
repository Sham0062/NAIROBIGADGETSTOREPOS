// Safaricom calls this URL with the payment result.
exports.handler = async (event) => {
  const ok = { statusCode: 200, body: JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }) };
  try {
    const cb = JSON.parse(event.body).Body.stkCallback;
    const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
    const get = (n) => (items.find(i => i.Name === n) || {}).Value;
    const patch = {
      status: cb.ResultCode === 0 ? 'paid' : (cb.ResultCode === 1032 ? 'cancelled' : 'failed'),
      result_desc: cb.ResultDesc,
      mpesa_receipt: get('MpesaReceiptNumber') || null,
      paid_amount: get('Amount') || null,
      updated_at: new Date().toISOString()
    };
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/payments?checkout_request_id=eq.${encodeURIComponent(cb.CheckoutRequestID)}&status=eq.pending`, {
      method: 'PATCH',
      headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
  } catch (e) { /* always ack so Safaricom doesn't retry */ }
  return ok;
};
