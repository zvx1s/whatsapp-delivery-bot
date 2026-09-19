require('dotenv').config();
const express = require('express');
const { handleInbound, onPaid } = require('./flow');
const { seenBefore, listHandoffs, getSession, saveSession } = require('./store');
const { webhookHandler } = require('./stripe');
const { sendText } = require('./send');

const app = express();

// Stripe needs the raw body for signature verification — mount BEFORE express.json()
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), webhookHandler(onPaid));
app.use(express.json());

// Meta webhook verification handshake
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === process.env.VERIFY_TOKEN)
    return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

// Inbound messages. Return 200 FAST — Meta retries slow responses and you double-send.
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;                       // status updates etc.
    if (seenBefore(msg.id)) return;         // dedupe retries
    const phone = msg.from;
    const profileName = value?.contacts?.[0]?.profile?.name;
    const input = { text: msg.text?.body,
      id: msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id };
    handleInbound(phone, input, profileName).catch(e => console.error('flow error', e));
  } catch (e) { console.error('webhook parse error', e); }
});

// ---- minimal owner inbox (Option 1's $350 piece grows from here) ----
app.get('/inbox', (req, res) => {
  const items = listHandoffs();
  res.type('html').send(`<h2>Waiting customers</h2>` + (items.length ? items.map(h =>
    `<p><b>${h.name}</b> (${h.phone}) — ${h.context}<br>
     <form method=post action=/inbox/reply>
       <input type=hidden name=phone value="${h.phone}">
       <input name=text placeholder="Reply..." size=50>
       <button>Send</button></form></p>`).join('') : '<p>None.</p>'));
});
app.post('/inbox/reply', express.urlencoded({ extended: false }), async (req, res) => {
  await sendText(req.body.phone, req.body.text);
  const s = getSession(req.body.phone);
  saveSession(req.body.phone, { paused_until: Date.now() + 2 * 3600e3 }); // keep bot quiet while human talks
  res.redirect('/inbox');
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening :${port}  DRY_RUN=${process.env.DRY_RUN || '0'}`));
