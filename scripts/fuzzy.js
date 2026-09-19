// Typo tolerance suite. Deliberately weighted toward FALSE POSITIVES —
// matching the wrong thing confidently is worse than apologizing.
//   node scripts/fuzzy.js
process.env.DRY_RUN = '1';
process.env.DB_PATH = './fuzzy.db';
try { require('fs').unlinkSync('./fuzzy.db'); } catch {}
const { handleInbound } = require('../src/flow');
const { CATALOG, T } = require('../config/shop');

let pass = 0, fail = 0; const failures = [];
const check = (name, cond, detail) => cond ? pass++ : (fail++, failures.push(`${name}${detail ? ' — ' + detail : ''}`));

let cap = []; const realLog = console.log;
console.log = (...a) => cap.push(a.join(' '));
let seq = 0;
const newPhone = () => `1650556${String(1000 + seq++)}`;

async function send(phone, input) {
  cap = [];
  await handleInbound(phone, input, 'Tester');
  return cap.join('\n');
}
async function at(steps, lang = 'lang_en') {
  const p = newPhone();
  await send(p, { text: 'hi' });
  await send(p, { id: lang });
  for (const st of steps) await send(p, st);
  return p;
}

const APOLOGY = /didn't catch that|no entendí eso/;

(async () => {
  // ===== TRUE POSITIVES — typos that should be understood =================
  {
    const cases = [
      // [label, steps to reach, typed text, must appear in reply]
      ['faq: wdedings',        [{ id: 'faq' }],                 'wdedings',        /wedding and event florals/i],
      ['faq: hors',            [{ id: 'faq' }],                 'hors',            /7:00 AM to 7:00 PM/],
      ['faq: same day ordrs',  [{ id: 'faq' }],                 'same day ordrs',  /Message us in the morning/i],
      ['menu: our arangements',[],                              'our arangements', /Teddy Bear & Roses/],
      ['method: delivry',      [{ id: 'browse' }, { id: 'FS1' }, { id: 'order' }], 'delivry', /delivery address/i],
      ['method: pickp',        [{ id: 'browse' }, { id: 'FS1' }, { id: 'order' }], 'pickp',   /When do you need it/i],
      ['product: ordr this one', [{ id: 'browse' }, { id: 'FS1' }],                'ordr this one', /delivery or pickup/i],
      ['browse: teddy bear rose', [{ id: 'browse' }],           'teddy bear rose', /\$150\.00  ·  FS1/],
      ['browse: sunflwer basket', [{ id: 'browse' }],           'sunflwer basket', /FS12/],
    ];
    for (const [label, steps, typed, expect] of cases) {
      const p = await at(steps);
      const out = await send(p, { text: typed });
      check(`understood — ${label}`, expect.test(out), out.replace(/\s+/g, ' ').slice(0, 110));
    }
  }
  {
    // when-step typo needs its own path (must get through address first)
    const p = await at([{ id: 'browse' }, { id: 'FS1' }, { id: 'order' }, { id: 'pickup' }]);
    const out = await send(p, { text: 'tomorow' });
    check('understood — when: tomorow', /card message/i.test(out), out.replace(/\s+/g, ' ').slice(0, 100));
  }
  {
    // Spanish typos
    const p = await at([{ id: 'faq' }], 'lang_es');
    const out = await send(p, { text: 'ubicasion' });
    check('understood — es: ubicasion', /1200 Market St/.test(out), out.replace(/\s+/g, ' ').slice(0, 100));
    const p2 = await at([{ id: 'faq' }], 'lang_es');
    const out2 = await send(p2, { text: 'bodas y evntos' });
    check('understood — es: bodas y evntos', /ramos, ceremonia/i.test(out2), out2.replace(/\s+/g, ' ').slice(0, 100));
  }

  // ===== FALSE POSITIVES — must NOT be confidently matched ================
  {
    // A word shared by many products is a question, not a selection.
    const p = await at([{ id: 'browse' }]);
    const out = await send(p, { text: 'roses' });
    const opened = /\$\d+\.00  ·  FS/.test(out);
    check('ambiguous "roses" does not open a specific product', !opened, out.replace(/\s+/g, ' ').slice(0, 110));
  }
  {
    const p = await at([{ id: 'browse' }]);
    const out = await send(p, { text: 'rosas' });
    check('ambiguous "rosas" does not open a specific product', !/\$\d+\.00  ·  FS/.test(out));
  }
  {
    // Several bouquets are "red roses" — must not pick one at random.
    const p = await at([{ id: 'browse' }]);
    const out = await send(p, { text: 'red roses' });
    check('ambiguous "red roses" does not open a specific product', !/\$\d+\.00  ·  FS/.test(out), out.replace(/\s+/g, ' ').slice(0, 110));
  }
  {
    // Pure gibberish must apologize, never guess.
    for (const junk of ['asdfgh', 'qwertyuiop', 'zzzzzz', '!!!!!!', 'xkcd42']) {
      const p = await at([]);
      const out = await send(p, { text: junk });
      check(`gibberish "${junk}" at menu apologizes`, APOLOGY.test(out), out.replace(/\s+/g, ' ').slice(0, 90));
    }
  }
  {
    // Gibberish at a button step must go through retry, not silently pick one.
    const p = await at([{ id: 'browse' }, { id: 'FS1' }, { id: 'order' }]);
    const out = await send(p, { text: 'asdfgh' });
    check('gibberish at method retries rather than guessing', APOLOGY.test(out) && !/delivery address/i.test(out));
  }

  // ===== FREE TEXT must stay content, not commands ========================
  {
    const p = await at([{ id: 'browse' }, { id: 'FS1' }, { id: 'order' }, { id: 'pickup' }, { id: 'today' }, { id: 'card_yes' }], 'lang_en');
    const out = await send(p, { text: 'For the most special person in my life' });
    check('card message containing "person" is NOT a handoff', !/get Luis/.test(out) && /what name/i.test(out), out.replace(/\s+/g, ' ').slice(0, 110));
  }
  {
    const p = await at([{ id: 'browse' }, { id: 'FS1' }, { id: 'order' }, { id: 'pickup' }, { id: 'today' }, { id: 'card_yes' }], 'lang_es');
    const out = await send(p, { text: 'Para la persona mas importante de mi vida' });
    check('es: card message containing "persona" is NOT a handoff', !/comunico con Luis/.test(out) && /a nombre de quién/i.test(out), out.replace(/\s+/g, ' ').slice(0, 110));
  }
  {
    // ...but a card-step message that IS a request for a human still escapes.
    const p = await at([{ id: 'browse' }, { id: 'FS1' }, { id: 'order' }, { id: 'pickup' }, { id: 'today' }, { id: 'card_yes' }], 'lang_es');
    const out = await send(p, { text: 'hablar con alguien' });
    check('es: "hablar con alguien" at card step DOES hand off', /comunico con Luis/.test(out), out.replace(/\s+/g, ' ').slice(0, 100));
  }
  {
    // Names that collide with option labels must be accepted as names.
    for (const name of ['Rose', 'Delivery Jones', 'Today']) {
      const p = await at([{ id: 'browse' }, { id: 'FS1' }, { id: 'order' }, { id: 'pickup' }, { id: 'today' }, { id: 'card_no' }]);
      const out = await send(p, { text: name });
      check(`name "${name}" accepted, reaches checkout`, /checkout\.stripe\.com/.test(out), out.replace(/\s+/g, ' ').slice(0, 90));
    }
  }
  {
    // Address free text must not be hijacked by fuzzy matching.
    const p = await at([{ id: 'browse' }, { id: 'FS1' }, { id: 'order' }, { id: 'delivery' }]);
    const out = await send(p, { text: '450 Oak St, Springfield' });
    check('address accepted verbatim', /When do you need it/i.test(out), out.replace(/\s+/g, ' ').slice(0, 90));
  }

  // ===== exact matches must still win over fuzzy =========================
  {
    const p = await at([{ id: 'browse' }]);
    const out = await send(p, { text: CATALOG[0].en[0] });
    check('exact product title still wins', /·  FS1$/m.test(out) || /FS1/.test(out));
    const p2 = await at([]);
    const out2 = await send(p2, { text: T.en.menu[1] });
    check('exact menu label still wins', /Common questions/.test(out2));
  }

  // ===== language step typo tolerance ====================================
  // Silently defaulting to English is the worst failure mode here: most of
  // this shop's customers pick Spanish, and a mistyped choice gave them an
  // English bot with no explanation.
  {
    for (const [typo, want] of [['englsh', /Thanks for messaging/], ['ingls', /Thanks for messaging/],
                                ['espanl', /Gracias por escribir/], ['spanich', /Gracias por escribir/],
                                ['espnol', /Gracias por escribir/]]) {
      const p = newPhone();
      await send(p, { text: 'hi' });
      const out = await send(p, { text: typo });
      check(`lang typo "${typo}" routes correctly`, want.test(out), out.replace(/\s+/g, ' ').slice(0, 70));
    }
    // unrecognizable input re-asks rather than assuming, but cannot loop
    const p = newPhone();
    await send(p, { text: 'hi' });
    const r1 = await send(p, { text: 'qwertyuiop' });
    check('unreadable language choice re-asks in both languages',
      /please tap one/.test(r1) && /toque una/.test(r1), r1.replace(/\s+/g, ' ').slice(0, 70));
    const r2 = await send(p, { text: 'zxcvbnm' });
    check('second failure defaults instead of looping', /Thanks for messaging/.test(r2), r2.replace(/\s+/g, ' ').slice(0, 70));
  }

  // ===== punctuation in labels ===========================================
  // norm() used to DELETE punctuation, so "Teddy Bear & Roses" became
  // "teddy bear  roses" (two spaces) and no typed input could ever match it
  // exactly. 17 of the 25 titles were affected.
  {
    for (const sku of ['FS1', 'FS10', 'FS21']) {
      const prod = CATALOG.find(c => c.sku === sku);
      const typed = prod.en[0].replace(/\s*&\s*/g, ' ');   // what a customer types
      const p = await at([{ id: 'browse' }]);
      const out = await send(p, { text: typed });
      check(`"${typed}" selects ${sku}`, new RegExp(`·  ${sku}\\b`).test(out), out.replace(/\s+/g, ' ').slice(0, 80));
    }
    const p = await at([{ id: 'faq' }]);
    const out = await send(p, { text: 'same day' });
    check('"same day" reaches the Same-day FAQ', /Message us in the morning/.test(out), out.replace(/\s+/g, ' ').slice(0, 80));
  }

  // ===== multi-word typos ================================================
  // Connector words must not drag the score below threshold.
  {
    for (const [typed, want] of [['weddigns and evnts', /We design full wedding/],
                                 ['custm arrangments', /Tell us your colors/]]) {
      const p = await at([{ id: 'faq' }]);
      const out = await send(p, { text: typed });
      check(`"${typed}" resolves`, want.test(out), out.replace(/\s+/g, ' ').slice(0, 80));
    }
    // ...but a connector-only message must still NOT match anything
    const p = await at([{ id: 'faq' }]);
    const out = await send(p, { text: 'and the' });
    check('"and the" matches nothing', !/We design full wedding|Tell us your colors|Monday through Saturday/.test(out));
  }

  console.log = realLog;
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log('   ✗ ' + f)); process.exitCode = 1; }
})();
