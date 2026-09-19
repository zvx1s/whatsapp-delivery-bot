// Independent probe: what does the matcher DO with each input?
// Reports outcome rather than pass/fail so the judgment can be eyeballed.
process.env.DRY_RUN = '1';
process.env.DB_PATH = './probe.db';
try { require('fs').unlinkSync('./probe.db'); } catch {}
const { handleInbound } = require('../src/flow');
const { CATALOG, T } = require('../config/shop');

let cap = []; const realLog = console.log;
console.log = (...a) => cap.push(a.join(' '));
let seq = 0;
const newPhone = () => `1650557${String(1000 + seq++)}`;

async function send(phone, input) { cap = []; await handleInbound(phone, input, 'T'); return cap.join('\n'); }

async function at(steps, lang = 'lang_en') {
  const p = newPhone();
  await send(p, { text: 'hi' });
  if (lang) await send(p, { id: lang });
  for (const st of steps) await send(p, st);
  return p;
}

// crude classifier of what the bot decided
function outcome(out) {
  if (!out.trim()) return 'SILENCE';
  if (/didn't catch that|no entend/.test(out)) return 'APOLOGY (no match)';
  if (/Luis|comunico con/.test(out) && /SMS to owner/.test(out)) return 'HANDOFF';
  const prod = CATALOG.find(c => out.includes(c.en[0] + '\n') || out.includes(c.es[0] + '\n'));
  if (prod && /\$\d+\.00  ·  FS/.test(out)) return `PRODUCT: ${prod.en[0]}`;
  const flat = out.replace(/\s+/g, ' ');
  for (let i = 0; i < T.en.faqs.length; i++)
    for (const L of ['en', 'es'])
      if (flat.includes(T[L].faqs[i][1].replace(/\s+/g, ' ').slice(0, 30)))
        return `FAQ ANSWER: ${T.en.faqs[i][0]}`;
  if (/Common questions|Preguntas frecuentes/.test(out)) return 'FAQ LIST';
  if (/delivery or pickup|entrega o para recoger/.test(out)) return 'ASKED DELIVERY/PICKUP';
  if (/When do you need|Para cuándo/.test(out)) return 'ASKED WHEN';
  if (/card message|tarjeta con mensaje/.test(out)) return 'ASKED CARD';
  if (/delivery address|dirección de entrega/.test(out)) return 'ASKED ADDRESS';
  if (/what name should|a nombre de quién/.test(out)) return 'ASKED NAME';
  if (/Show more|Ver más/.test(out)) return 'PRODUCT LIST';
  if (/Which language|Qué idioma/.test(out)) return 'LANG PROMPT';
  if (/Gracias por escribir/.test(out)) return 'GREETING → SPANISH';
  if (/Thanks for messaging/.test(out)) return 'GREETING → ENGLISH';
  if (/please tap one|por favor toque una/.test(out)) return 'RE-ASKED LANGUAGE';
  if (/Anything else|Algo más/.test(out)) return 'MAIN MENU';
  return 'other: ' + out.replace(/\s+/g, ' ').slice(0, 70);
}

const rows = [];
async function probe(group, setup, input, note, lang) {
  const p = await at(setup, lang);
  const out = await send(p, typeof input === 'string' ? { text: input } : input);
  rows.push([group, JSON.stringify(input.text || input), outcome(out), note || '']);
}

(async () => {
  // --- the user's actual example ---
  await probe('FAQ typos', [{ id: 'faq' }], 'wdedings', 'want: Weddings FAQ');
  await probe('FAQ typos', [{ id: 'faq' }], 'weddigns and evnts', 'want: Weddings FAQ');
  await probe('FAQ typos', [{ id: 'faq' }], 'custm arrangments', 'want: Custom FAQ');
  await probe('FAQ typos', [{ id: 'faq' }], 'same day', 'want: Same-day FAQ');
  await probe('FAQ typos', [{ id: 'faq' }], 'hor', 'short — want APOLOGY not a wrong FAQ');
  await probe('FAQ typos', [{ id: 'faq' }], 'bodas y evntos', 'ES word at EN step — want APOLOGY');

  // --- language step (suspected gap) ---
  await probe('Language', [], 'englsh', 'want: English', null);
  await probe('Language', [], 'espanl', 'want: SPANISH not English', null);
  await probe('Language', [], 'spanich', 'want: SPANISH not English', null);
  await probe('Language', [], 'ingls', 'want: English', null);

  // --- ambiguity: must refuse to guess ---
  await probe('Ambiguity', [{ id: 'browse' }], 'roses', 'many match — want APOLOGY/LIST not a pick');
  await probe('Ambiguity', [{ id: 'browse' }], 'rosas', 'many match — want no confident pick');
  await probe('Ambiguity', [{ id: 'browse' }], 'sunflower', '4 sunflower items — want no pick');
  await probe('Ambiguity', [{ id: 'browse' }], 'bear', 'several bears — want no pick');

  // --- product typos that SHOULD land ---
  await probe('Product typos', [{ id: 'browse' }], 'teddy ber and roses', 'want: Teddy Bear & Roses');
  await probe('Product typos', [{ id: 'browse' }], 'clasic red rosas', 'want: Classic Red Roses');
  await probe('Product typos', [{ id: 'browse' }], 'sunflwer basket', 'want: Sunflower Basket');

  // --- order-step typos ---
  const toMethod = [{ id: 'browse' }, { id: 'FS1' }, { id: 'order' }];
  await probe('Order typos', toMethod, 'delivry', 'want: address asked');
  await probe('Order typos', toMethod, 'pickip', 'want: when asked');
  await probe('Order typos', toMethod, 'entrga', 'ES word at EN step');
  await probe('Order typos', [...toMethod, { id: 'pickup' }], 'tomorow', 'want: card asked');
  await probe('Order typos', [...toMethod, { id: 'pickup' }], 'anther day', 'want: card asked');

  // --- short/dangerous strings ---
  await probe('Short strings', [...toMethod, { id: 'pickup' }, { id: 'today' }], 'yes', 'want: card text asked');
  await probe('Short strings', [...toMethod, { id: 'pickup' }, { id: 'today' }], 'yep', 'want: card OR apology, not "No message"');
  await probe('Short strings', [...toMethod, { id: 'pickup' }, { id: 'today' }], 'nope', 'want: name asked OR apology');

  // --- false positives: unrelated text must NOT match ---
  await probe('False positive', [{ id: 'faq' }], 'I am so cool', 'want APOLOGY');
  await probe('False positive', [{ id: 'browse' }], 'how much is shipping to my house', 'want no product pick');
  await probe('False positive', [{ id: 'faq' }], 'do you sell chocolate', 'want APOLOGY');
  await probe('False positive', [{ id: 'browse' }], 'asdfgh qwerty', 'want APOLOGY/LIST');

  // --- Spanish side ---
  await probe('Spanish', [{ id: 'faq' }], 'bodas', 'want: Bodas FAQ', 'lang_es');
  await probe('Spanish', [{ id: 'faq' }], 'ubicacon', 'want: Ubicación FAQ', 'lang_es');
  await probe('Spanish', [{ id: 'faq' }], 'horaio', 'want: Horario FAQ', 'lang_es');
  await probe('Spanish', [{ id: 'browse' }], 'girasol en maceta', 'exact ES title', 'lang_es');

  // --- free-text steps must stay literal ---
  const toName = [{ id: 'browse' }, { id: 'FS1' }, { id: 'order' }, { id: 'pickup' }, { id: 'today' }, { id: 'card_no' }];
  await probe('Free text', toName, 'Ana Reyess', 'name — want checkout, not a match');
  await probe('Free text', toName, 'Hours', 'name literally "Hours" — want checkout');
  const toCard = [{ id: 'browse' }, { id: 'FS1' }, { id: 'order' }, { id: 'pickup' }, { id: 'today' }, { id: 'card_yes' }];
  await probe('Free text', toCard, 'Para una persona especial', 'card msg — must NOT handoff');
  await probe('Free text', toCard, 'Te quiero mucho', 'card msg — must reach name step');

  console.log = realLog;
  let g = '';
  for (const [group, input, out, note] of rows) {
    if (group !== g) { console.log(`\n── ${group} ${'─'.repeat(60 - group.length)}`); g = group; }
    console.log(`  ${input.padEnd(34)} → ${out.padEnd(30)} ${note}`);
  }
})();
