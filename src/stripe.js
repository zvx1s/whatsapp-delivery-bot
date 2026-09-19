// Stripe checkout + webhook. DRY_RUN returns a fake link so the flow is testable offline.
const DRY = process.env.DRY_RUN === '1';
const stripe = process.env.STRIPE_KEY ? require('stripe')(process.env.STRIPE_KEY) : null;

async function createCheckout(phone, product, order, language) {
  const deliveryFee = order.address ? 15 : 0;
  if (DRY || !stripe) return `https://checkout.stripe.com/test_${product.sku}_${Date.now()}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      { price_data: { currency: 'usd', unit_amount: product.p * 100,
        product_data: { name: product[language][0] } }, quantity: 1 },
      ...(deliveryFee ? [{ price_data: { currency: 'usd', unit_amount: deliveryFee * 100,
        product_data: { name: language === 'es' ? 'Entrega' : 'Delivery' } }, quantity: 1 }] : [])
    ],
    metadata: { phone, sku: product.sku },
    success_url: process.env.SUCCESS_URL || 'https://example.com',
    cancel_url: process.env.CANCEL_URL || 'https://example.com'
  });
  return session.url;
}

// Express handler. IMPORTANT: mount with express.raw({type:'application/json'})
function webhookHandler(onPaid) {
  return async (req, res) => {
    let event = req.body;
    if (stripe && process.env.STRIPE_WEBHOOK_SECRET) {
      try {
        event = stripe.webhooks.constructEvent(
          req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
      } catch (e) { return res.status(400).send(`sig verification failed: ${e.message}`); }
    } else if (Buffer.isBuffer(event)) event = JSON.parse(event.toString());
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      await onPaid(s.metadata.phone, s);
    }
    res.json({ received: true });
  };
}

module.exports = { createCheckout, webhookHandler };
