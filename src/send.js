// All outbound WhatsApp messages go through here.
// DRY_RUN=1 -> pretty-print to console instead of calling the Graph API.
// Swap nothing else in the codebase when going live.
const DRY = process.env.DRY_RUN === '1';
const TOKEN = process.env.WA_TOKEN;           // SYSTEM USER token, not the 24h dashboard one
const PHONE_ID = process.env.WA_PHONE_ID;

async function graph(payload) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) console.error('send failed', res.status, await res.text());
  return res;
}

function wrap(to, inner) {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...inner };
}

async function sendText(to, body) {
  const p = wrap(to, { type: 'text', text: { body } });
  if (DRY) return console.log(`\n  🤖 → ${to}\n  ${body.split('\n').join('\n  ')}`);
  return graph(p);
}

// max 3 buttons — Meta hard limit
async function sendButtons(to, body, buttons) {
  if (buttons.length > 3) throw new Error('WhatsApp allows max 3 buttons');
  const p = wrap(to, { type: 'interactive', interactive: {
    type: 'button', body: { text: body },
    action: { buttons: buttons.map(([id, title]) => ({ type: 'reply', reply: { id, title: title.slice(0, 20) } })) }
  }});
  if (DRY) return console.log(`\n  🤖 → ${to}\n  ${body}\n  ${buttons.map(b => `[ ${b[1]} ]`).join(' ')}`);
  return graph(p);
}

// max 10 rows, title<=24, description<=72 — Meta hard limits
async function sendList(to, body, buttonLabel, rows) {
  if (rows.length > 10) throw new Error('WhatsApp allows max 10 list rows');
  const p = wrap(to, { type: 'interactive', interactive: {
    type: 'list', body: { text: body },
    action: { button: buttonLabel.slice(0, 20), sections: [{ rows: rows.map(([id, title, desc]) => ({
      id, title: title.slice(0, 24), ...(desc ? { description: desc.slice(0, 72) } : {}) })) }] }
  }});
  if (DRY) return console.log(`\n  🤖 → ${to}\n  ${body}\n  ${rows.map(r => `  · ${r[1]}${r[2] ? ' — ' + r[2] : ''}`).join('\n')}`);
  return graph(p);
}

async function sendImage(to, link, caption) {
  const p = wrap(to, { type: 'image', image: { link, caption } });
  if (DRY) return console.log(`\n  🤖 → ${to}\n  [image] ${caption || link}`);
  return graph(p);
}

// Owner alert — Twilio SMS. DRY prints; live needs TWILIO_* env vars.
async function smsOwner(text) {
  if (DRY) return console.log(`\n  📱 SMS to owner: ${text}`);
  const sid = process.env.TWILIO_SID, tok = process.env.TWILIO_TOKEN;
  const body = new URLSearchParams({ From: process.env.TWILIO_FROM, To: process.env.OWNER_PHONE, Body: text });
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') },
    body
  });
}

async function emailShop(subject, text) {
  if (DRY) return console.log(`\n  ✉️  EMAIL "${subject}"\n  ${text.split('\n').join('\n  ')}`);
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: process.env.SHOP_EMAIL, subject, text })
  });
}

module.exports = { sendText, sendButtons, sendList, sendImage, smsOwner, emailShop };
