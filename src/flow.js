// Conversation engine — a step machine keyed on session.step.
// The tree mirrors flower-bot-demo.html. All copy comes from config/shop.js.
// DETERMINISTIC: prices, hours, products only ever come from config, never generated.
const { CATALOG, T } = require('../config/shop');
const { getSession, saveSession, flagHandoff } = require('./store');
const { sendText, sendButtons, sendList, smsOwner, emailShop } = require('./send');
const { createCheckout } = require('./stripe');

const PAGE = 8;   // 8 products + "Show more" + "← Back" = Meta's 10-row max
const t = (s) => T[s.language || 'en'];

// --- typed-text resolution -------------------------------------------------
// Customers type instead of tapping. Match what they wrote against the labels
// we actually showed them, plus a few obvious synonyms. Config-driven, no LLM.
// Punctuation becomes a SPACE, not nothing. "Teddy Bear & Roses" has to
// normalize to "teddy bear roses" — deleting the "&" leaves a double space and
// no customer ever types that, which silently broke exact matching on 17 of the
// 25 titles. Same for the hyphen in "Same-day orders".
const norm = (x) => (x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const toks = (x) => x.split(/\s+/).filter(Boolean);

// --- fuzzy matching --------------------------------------------------------
// Typo tolerance, still fully deterministic — no model, no network. We only
// ever match against labels this shop actually showed the customer.
//
// Two rules keep it honest:
//   1. A match must clear MIN_SIM. Below that we say "I didn't catch that"
//      rather than guess.
//   2. The winner must beat the runner-up by MIN_MARGIN. If two arrangements
//      score alike, the input was ambiguous and guessing would be worse than
//      asking. "rosas" matches nine bouquets equally — that is a question,
//      not a selection.
const MIN_SIM = 0.75;
const MIN_MARGIN = 0.10;

// Damerau-Levenshtein: edit distance that also counts a transposition as one
// edit, because "wdedings" and "teh" are how people actually mistype.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}
const ratio = (a, b) => (!a.length && !b.length) ? 1 : 1 - editDistance(a, b) / Math.max(a.length, b.length);

// Score input against a label by token coverage: every word the customer typed
// has to land somewhere in the label. That lets "wdedings" hit "Weddings &
// events" while stopping a single shared word like "roses" from claiming a
// specific bouquet.
function labelScore(n, label) {
  const L = toks(norm(label));
  if (!L.length) return 0;
  const N = toks(n);
  if (!N.length) return 0;
  const whole = ratio(n, norm(label));
  // Connector words ("and", "y", "de", "the") carry no meaning but tank the
  // average — "weddigns and evnts" scored below threshold purely because of
  // "and". Score on the substantive words when there are any.
  const sig = N.filter(w => w.length > 3);
  const use = sig.length ? sig : N;
  const covered = use.map(w => Math.max(...L.map(l => ratio(w, l))));
  const avg = covered.reduce((a, b) => a + b, 0) / covered.length;
  return Math.max(whole, avg);
}

// Everything selectable on the screen the customer is currently looking at.
// Free-text steps (address, name, card message) deliberately return nothing —
// that input is content, not a command.
function candidates(s, step) {
  const tt = t(s);
  const L = s.language || 'en';
  const out = [];
  const add = (id, label) => { if (label) out.push([id, label]); };

  if (step === 'lang') {
    add('lang_en', 'English'); add('lang_en', 'Ingles');
    add('lang_es', 'Espanol'); add('lang_es', 'Spanish');
  }
  if (step === 'method') { add('delivery', tt.delivery); add('pickup', tt.pickup); }
  if (step === 'when') { add('today', tt.today); add('tomorrow', tt.tomorrow); add('other', tt.other); }
  if (step === 'card_ask') { add('card_yes', tt.yes); add('card_no', tt.noCard); }
  if (step === 'product') { add('order', tt.order); add('back_list', tt.backList); add('talk', tt.talk); }
  if (step === 'browse') {
    add('back_menu', tt.backMenu);
    add('page_' + (((s.order?._page) || 0) + 1), tt.more);
    for (const p of CATALOG) add(p.sku, p[L][0]);
  }
  if (step === 'faq') tt.faqs.forEach((f, i) => add(`faq_${i}`, f[0]));
  if (['menu', 'faq', 'browse', 'awaiting_payment'].includes(step)) {
    add('browse', tt.menu[0]); add('faq', tt.menu[1]); add('talk', tt.menu[2]);
    add('back_menu', tt.backMenu);
  }
  return out;
}

function fuzzyResolve(n, s, step) {
  if (n.length < 3) return null;              // too short to be a confident typo
  let best = null, bestScore = 0, runnerUp = 0;
  for (const [id, label] of candidates(s, step)) {
    const sc = labelScore(n, label);
    if (sc > bestScore) {
      if (id !== best) runnerUp = bestScore;
      bestScore = sc; best = id;
    } else if (sc > runnerUp && id !== best) runnerUp = sc;
  }
  if (best === null || bestScore < MIN_SIM) return null;
  if (bestScore - runnerUp < MIN_MARGIN) return null;   // ambiguous — ask instead
  return best;
}

function resolveText(text, s, step) {
  const tt = t(s);
  const n = norm(text);
  if (!n) return null;

  // NUMBERS: map to whatever menu is currently on screen.
  const numMatch = /^([1-9]|10)$/.exec(n);
  if (numMatch) {
    const opts = s.order?._opts || [];
    const pick = opts[parseInt(numMatch[1], 10) - 1];
    if (pick) return pick;
  }

  // STEP-SPECIFIC LABELS FIRST — context beats generic synonyms.
  // ("Order this one" must mean order, not browse.)
  const pairs = {
    method: [['delivery', tt.delivery], ['pickup', tt.pickup]],
    when:   [['today', tt.today], ['tomorrow', tt.tomorrow], ['other', tt.other]],
    card_ask: [['card_yes', tt.yes], ['card_no', tt.noCard]],
    product: [['order', tt.order], ['back_list', tt.backList]],
    browse: [['back_menu', tt.backMenu],
             ['page_' + (((s.order?._page) || 0) + 1), tt.more],
             ['page_0', tt.startOver]]
  }[step] || [];
  for (const [id, label] of pairs) if (norm(label) === n) return id;

  // menu options by exact label, either language
  const menuMap = [['browse', 0], ['faq', 1], ['talk', 2]];
  for (const [id, i] of menuMap)
    for (const L of ['en', 'es']) if (norm(T[L].menu[i]) === n) return id;

  // list rows: exact product title, or a number ("1" = first shown)
  if (step === 'browse') {
    const p = CATALOG.find(x => norm(x[s.language || 'en'][0]) === n);
    if (p) return p.sku;
  }
  if (step === 'faq') {
    const i = tt.faqs.findIndex(f => norm(f[0]) === n);
    if (i >= 0) return `faq_${i}`;
  }

  // LAST: loose synonyms, only when nothing specific matched
  if (/^(back|go back|menu|start|hi|hello|hola|inicio|atras|regresar|volver)$/.test(n))
    return step === 'product' ? 'back_list' : 'back_menu';
  if (/^(more|show more|next|mas|ver mas)$/.test(n) && step === 'browse')
    return 'page_' + (((s.order?._page) || 0) + 1);
  if (/\b(flower|flores|arreglo|arreglos|bouquet|ramo|buy|comprar|see|ver)\b/.test(n)) return 'browse';
  if (/\b(question|pregunta|hours|horario|address|ubicacion|price|precio)\b/.test(n)) return 'faq';

  // FINALLY: typo tolerance. Runs only after every exact path has failed, so
  // it can never override a match the customer actually spelled correctly.
  return fuzzyResolve(n, s, step);
}


async function handleInbound(phone, input, profileName) {
  const s = getSession(phone);

  // Handoff pause: human owns the conversation, bot stays silent
  if (s.paused_until > Date.now()) return;

  const text = (input.text || '').trim();
  let id = input.id || null;            // button/list reply id
  const step = s.step || 'start';

  // language buttons by typed word
  if (!id && step === 'lang') {
    const n = norm(text);
    if (/^(en|english|ingles)$/.test(n)) id = 'lang_en';
    if (/^(es|espanol|spanish)$/.test(n)) id = 'lang_es';
  }
  // Steps where the customer is dictating CONTENT, not choosing an option.
  // A card message reading "para la persona más importante" must not be read
  // as a request for a human — that drops the message and pauses the bot
  // mid-order. But someone whose whole message IS "talk to someone" still
  // gets through, so we require the full phrase rather than one loose keyword.
  const FREE_TEXT = step === 'card_text';
  const talkPhrase = norm(t(s).talk);
  const asksForHuman = FREE_TEXT
    ? norm(text).includes(talkPhrase) && norm(text).length <= talkPhrase.length * 2.5
    : (id === 'talk' || /\b(agent|human|person|someone|talk to|hablar|alguien|persona)\b/i.test(text));

  if (!id && text && !FREE_TEXT) id = resolveText(text, s, step) || null;

  // global escape hatches — match keywords inside sentences, not just exact text
  if (asksForHuman) return handoff(phone, s, profileName);

  switch (step) {
    case 'start': {
      saveSession(phone, { step: 'lang' });
      await offerButtons(phone, getSession(phone),
        "Hi! 💐 Flor y Sol.\n¡Hola! Flor y Sol.\n\nWhich language do you prefer?\n¿Qué idioma prefiere?",
        [['lang_en', 'English'], ['lang_es', 'Español']]);
      return;
    }
    case 'lang': {
      // Never silently assume English. A Spanish speaker who mistypes and gets
      // an English bot has no idea why, and most of this shop's customers are
      // choosing Spanish. Ask once more in both languages, then default so
      // nobody can get stuck in a loop.
      if (id !== 'lang_en' && id !== 'lang_es') {
        const o = s.order || {};
        if (!o._langTry) {
          o._langTry = 1;
          saveSession(phone, { order: o, step: 'lang' });
          return offerButtons(phone, getSession(phone),
            "Sorry, I didn't catch that — please tap one.\nDisculpe, no entendí — por favor toque una.",
            [['lang_en', 'English'], ['lang_es', 'Español']]);
        }
      }
      const language = id === 'lang_es' ? 'es' : 'en';
      saveSession(phone, { language, step: 'menu', order: {} });
      const tt = T[language];
      await sendText(phone, tt.greeting);
      return mainMenu(phone, language);
    }
    case 'menu': {
      if (id === 'browse') return browse(phone, s, 0);
      if (id === 'faq') return faqMenu(phone, s);
      if (id === 'back_menu') return mainMenu(phone, s.language);
      // unrecognized: say so once, then re-offer. Never silently loop.
      await sendText(phone, s.language === 'es'
        ? 'Disculpe, no entendí eso. Puede escoger una opción abajo, o escribir "hablar" para comunicarse con alguien.'
        : "Sorry, I didn't catch that. Pick an option below, or type \"talk\" to reach a person.");
      return mainMenu(phone, s.language);
    }
    case 'browse': {
      if (id?.startsWith('page_')) return browse(phone, s, parseInt(id.slice(5), 10));
      if (id === 'back_menu') { saveSession(phone, { step: 'menu' }); return mainMenu(phone, s.language); }
      const p = CATALOG.find(x => x.sku === id);
      if (p) return showProduct(phone, s, p);
      return browse(phone, s, 0);
    }
    case 'product': {
      const o = s.order;
      if (id === 'order') {
        await offerButtons(phone, s, t(s).askMethod, [['delivery', t(s).delivery], ['pickup', t(s).pickup]]);
        saveSession(phone, { step: 'method', order: o });
        return;
      }
      if (id === 'back_list') return browse(phone, s, o._page || 0);
      return browse(phone, s, 0);
    }
    case 'method': {
      const o = s.order;
      if (id !== 'delivery' && id !== 'pickup')
        return retry(phone, s, 'method', () =>
          sendButtons(phone, t(s).askMethod, [['delivery', t(s).delivery], ['pickup', t(s).pickup]]));
      o.method = id === 'delivery' ? t(s).delivery : t(s).pickup;
      if (id === 'delivery') { saveSession(phone, { step: 'address', order: o }); return sendText(phone, t(s).askAddress); }
      saveSession(phone, { step: 'when', order: o });
      return askWhen(phone, s);
    }
    case 'address': {
      const o = s.order;
      // A usable address has a number and some substance. Re-ask ONCE, then accept
      // and flag it — never block a sale over validation.
      const plausible = /\d/.test(text) && text.length >= 8;
      if (!plausible && (o._retry || 0) < 1) {
        o._retry = 1; saveSession(phone, { order: o });
        return sendText(phone, s.language === 'es'
          ? 'Necesito la dirección completa con el número de la calle. Por ejemplo: 450 Oak St, Springfield.'
          : 'I need the full street address including the number. For example: 450 Oak St, Springfield.');
      }
      o.address = text;
      if (!plausible) o.addressFlag = 'NEEDS CHECKING';
      o._retry = 0;
      saveSession(phone, { step: 'when', order: o });
      return askWhen(phone, s);
    }
    case 'when': {
      const o = s.order;
      const valid = ['today', 'tomorrow', 'other'];
      if (!valid.includes(id)) return retry(phone, s, 'when', () => askWhen(phone, s));
      o.when = { today: t(s).today, tomorrow: t(s).tomorrow, other: t(s).other }[id];
      o._retry = 0;
      saveSession(phone, { step: 'card_ask', order: o });
      return offerButtons(phone, s, t(s).askCard, [['card_yes', t(s).yes], ['card_no', t(s).noCard]]);
    }
    case 'card_ask': {
      if (id === 'card_yes') { saveSession(phone, { step: 'card_text' }); return sendText(phone, t(s).askCardText); }
      if (id === 'card_no') { saveSession(phone, { step: 'name' }); return sendText(phone, t(s).askName); }
      return retry(phone, s, 'card_ask', () =>
        sendButtons(phone, t(s).askCard, [['card_yes', t(s).yes], ['card_no', t(s).noCard]]));
    }
    case 'card_text': {
      const o = s.order; o.cardMessage = text;
      saveSession(phone, { step: 'name', order: o });
      return sendText(phone, t(s).askName);
    }
    case 'name': {
      const o = s.order;
      if (!text || text.length < 2 || text.length > 60) {
        return retry(phone, s, 'name', () => sendText(phone, t(s).askName), true);
      }
      o.name = text;
      o._retry = 0;
      const p = CATALOG.find(x => x.sku === o.sku);
      const url = await createCheckout(phone, p, o, s.language);
      await sendText(phone, t(s).summary(o.name.split(' ')[0], p, o.method, o.method === t(s).delivery ? 15 : 0)
        + `\n\n${url}`);
      saveSession(phone, { step: 'awaiting_payment', order: o });
      return;
    }
    case 'awaiting_payment': {
      // Customer messaged instead of paying. Must stay fully navigable —
      // a payment link is not a dead end.
      if (id === 'browse') return browse(phone, s, 0);
      if (id === 'faq') return faqMenu(phone, s);
      if (id === 'back_menu') return mainMenu(phone, s.language);
      const pick = CATALOG.find(x => x.sku === id);
      if (pick) return showProduct(phone, s, pick);
      await sendText(phone, s.language === 'es'
        ? 'Su enlace de pago sigue activo arriba. ¿Le puedo ayudar con algo más mientras tanto?'
        : "Your payment link above is still good. Can I help with anything else in the meantime?");
      return mainMenu(phone, s.language);
    }
    case 'faq': {
      const f = t(s).faqs.find((x, i) => id === `faq_${i}`);
      if (f) {
        await sendText(phone, f[1]);
        return offerButtons(phone, s, t(s).anythingElse,
          [['faq', t(s).another], ['browse', t(s).menu[0]], ['talk', t(s).menu[2]]]);
      }
      if (id === 'browse') return browse(phone, s, 0);
      if (id === 'back_menu') { saveSession(phone, { step: 'menu' }); return mainMenu(phone, s.language); }
      return faqMenu(phone, s);
    }
    default: {
      saveSession(phone, { step: 'menu' });
      return mainMenu(phone, s.language || 'en');
    }
  }
}


// Re-prompt on invalid input. After 2 failed tries, stop nagging and offer a person.
async function retry(phone, s, step, reprompt, freeText) {
  const o = s.order || {};
  const n = (o._retry || 0) + 1;
  o._retry = n;
  saveSession(phone, { order: o, step });
  if (n >= 3) {                       // stop nagging, hand to a human
    o._retry = 0; saveSession(phone, { order: o });
    return handoff(phone, s, null);
  }
  const es = s.language === 'es';
  await sendText(phone, freeText
    ? (es ? 'Disculpe, no entendí eso. ¿Me lo puede escribir otra vez?'
          : "Sorry, I didn't catch that. Could you type it again?")
    : (es ? 'Disculpe, no entendí eso. Por favor escoja una de las opciones.'
          : "Sorry, I didn't catch that. Please pick one of the options."));
  return reprompt();
}


// Every menu we show is recorded on the session as _opts (ordered ids), so a
// customer typing "1"/"2"/"3" always selects what they're actually looking at.
async function offerButtons(phone, s, body, buttons) {
  const o = s.order || {};
  o._opts = buttons.map(b => b[0]);
  saveSession(phone, { order: o });
  return sendButtons(phone, body, buttons);
}
async function offerList(phone, s, body, label, rows) {
  const o = s.order || {};
  o._opts = rows.map(r => r[0]);
  saveSession(phone, { order: o });
  return sendList(phone, body, label, rows);
}

async function mainMenu(phone, language) {
  const tt = T[language || 'en'];
  saveSession(phone, { step: 'menu' });
  const s = getSession(phone);
  await offerButtons(phone, s, tt.anythingElse ?? 'Menu',
    [['browse', tt.menu[0]], ['faq', tt.menu[1]], ['talk', tt.menu[2]]]);
}

const LAST_PAGE = Math.max(0, Math.ceil(CATALOG.length / PAGE) - 1);

async function browse(phone, s, page) {
  const tt = t(s);
  const L = s.language || 'en';
  // Clamp: a bogus or out-of-range page id must never render an empty list.
  const pg = Number.isInteger(page) && page > 0 ? Math.min(page, LAST_PAGE) : 0;
  const rows = CATALOG.slice(pg * PAGE, pg * PAGE + PAGE)
    .map(p => [p.sku, p[L][0], p[L][1]]);
  // Exactly ONE back affordance, always last, identical on every page.
  // PAGE is sized so products + "Show more" + "← Back" can never exceed
  // Meta's 10-row list limit — otherwise the back row gets silently dropped.
  if (pg < LAST_PAGE) rows.push([`page_${pg + 1}`, tt.more, tt.moreSub]);
  rows.push(['back_menu', tt.backMenu, '']);
  await offerList(phone, s, pg === 0 ? tt.browseIntro : tt.prodHead, tt.prodHead, rows.slice(0, 10));
  const o = s.order; o._page = pg;
  saveSession(phone, { step: 'browse', order: o });
}

async function showProduct(phone, s, p) {
  const tt = t(s);
  await sendText(phone, `${p[s.language][0]}\n${p[s.language][1]}\n\n$${p.p}.00  ·  ${p.sku}`);
  await offerButtons(phone, s, ' ', [['order', tt.order], ['back_list', tt.backList], ['talk', tt.talk]]);
  const o = s.order; o.sku = p.sku;
  saveSession(phone, { step: 'product', order: o });
}

async function askWhen(phone, s) {
  const tt = t(s);
  return offerButtons(phone, s, tt.askWhen, [['today', tt.today], ['tomorrow', tt.tomorrow], ['other', tt.other]]);
}

async function faqMenu(phone, s) {
  const tt = t(s);
  const rows = tt.faqs.map((f, i) => [`faq_${i}`, f[0], '']);
  rows.push(['back_menu', tt.backMenu, '']);
  await offerList(phone, s, tt.faqHead, tt.faqHead, rows.slice(0, 10));
  saveSession(phone, { step: 'faq' });
}

async function handoff(phone, s, profileName) {
  const tt = t(s.language ? s : { language: 'en' });
  await sendText(phone, tt.handoff);
  const p = s.order?.sku ? CATALOG.find(x => x.sku === s.order.sku) : null;
  const ctx = p ? `Viewing: ${p.en[0]} $${p.p}` : 'General inquiry';
  flagHandoff(phone, profileName, ctx);
  saveSession(phone, { paused_until: Date.now() + 2 * 3600e3 });  // bot silent 2h
  await smsOwner(`Customer waiting on WhatsApp — ${profileName || phone}. ${ctx}. Reply: ${process.env.INBOX_URL || 'http://localhost:3000/inbox'}`);
}

// Stripe webhook calls this after checkout.session.completed
async function onPaid(phone, sessionData) {
  const s = getSession(phone);
  const tt = t(s);
  const o = s.order;
  const p = CATALOG.find(x => x.sku === o.sku);
  await sendText(phone, tt.paid(o.name?.split(' ')[0] || ''));
  await emailShop(`New order — ${p?.en[0]} — ${o.name}`,
`Customer: ${o.name}
WhatsApp: ${phone}
Item: ${p?.en[0]} (${o.sku}) — $${p?.p}.00
${o.method}${o.address ? '\nAddress: ' + o.address + (o.addressFlag ? '  ⚠️ ' + o.addressFlag : '') : ''}
Date: ${o.when}
Card message: ${o.cardMessage || '—'}

Payment: PAID via Stripe
Stripe ref: ${sessionData.id || 'test'}`);
  saveSession(phone, { step: 'menu', order: {} });
}

module.exports = { handleInbound, onPaid };
