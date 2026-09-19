// Assertion suite for adversarial input. Complements harness.js (which prints
// a happy path but asserts nothing).
//   node scripts/adversarial.js
process.env.DRY_RUN = '1';
process.env.DB_PATH = './adv.db';
const fs = require('fs');
try { fs.unlinkSync('./adv.db'); } catch {}
const { handleInbound } = require('../src/flow');
const { CATALOG, T } = require('../config/shop');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

// --- capture outbound messages ---------------------------------------------
let cap = [];
const realLog = console.log;
console.log = (...a) => cap.push(a.join(' '));
const flush = () => { const s = cap.join('\n'); cap = []; return s; };

let seq = 0;
const newPhone = () => `1650555${String(1000 + seq++)}`;

// send input, return { text, rows, buttons }
async function send(phone, input) {
  cap = [];
  await handleInbound(phone, input, 'Tester');
  const out = flush();
  const rows = out.split('\n').filter(l => l.trim().startsWith('·')).map(l => l.replace(/^\s*·\s*/, '').split(' — ')[0].trim());
  const buttons = [...out.matchAll(/\[ ([^\]]+) \]/g)].map(m => m[1].trim());
  return { out, rows, buttons };
}

async function startEn() {
  const p = newPhone();
  await send(p, { text: 'hi' });
  await send(p, { id: 'lang_en' });
  return p;
}

(async () => {
  const EN = T.en;
  const LAST = Math.ceil(CATALOG.length / 8) - 1;

  // === 1. paging shape ======================================================
  {
    const p = await startEn();
    let r = await send(p, { id: 'browse' });
    const seenSkus = [];
    for (let page = 0; page <= LAST; page++) {
      if (page > 0) r = await send(p, { id: `page_${page}` });
      const backs = r.rows.filter(x => x === EN.backMenu || x === EN.startOver);
      check(`page ${page}: exactly one back row`, backs.length === 1, `got ${backs.length}: ${JSON.stringify(backs)}`);
      check(`page ${page}: within Meta 10-row limit`, r.rows.length <= 10, `${r.rows.length} rows`);
      check(`page ${page}: back row is last`, r.rows[r.rows.length - 1] === EN.backMenu, `last row = ${JSON.stringify(r.rows[r.rows.length - 1])}`);
      const more = r.rows.filter(x => x === EN.more).length;
      check(`page ${page}: "Show more" present iff not last`, more === (page < LAST ? 1 : 0));
      seenSkus.push(...r.rows.filter(x => CATALOG.some(c => c.en[0] === x)));
    }
    check('every product reachable exactly once across pages',
      seenSkus.length === CATALOG.length && new Set(seenSkus).size === CATALOG.length,
      `${seenSkus.length} shown, ${new Set(seenSkus).size} unique, catalog ${CATALOG.length}`);
  }

  // === 2. out-of-range / garbage page ids ===================================
  for (const bad of ['page_99', 'page_-3', 'page_abc', 'page_', 'page_1e9']) {
    const p = await startEn();
    await send(p, { id: 'browse' });
    const r = await send(p, { id: bad });
    check(`garbage id ${bad}: renders a non-empty product list`,
      r.rows.length >= 2 && r.rows.some(x => CATALOG.some(c => c.en[0] === x)),
      `rows: ${JSON.stringify(r.rows)}`);
    check(`garbage id ${bad}: still exactly one back row`,
      r.rows.filter(x => x === EN.backMenu).length === 1);
  }

  // === 3. typed navigation still resolves ===================================
  {
    const p = await startEn();
    await send(p, { id: 'browse' });
    const r = await send(p, { text: 'more' });
    check('typed "more" advances a page', r.rows.some(x => CATALOG.slice(8, 16).some(c => c.en[0] === x)), JSON.stringify(r.rows.slice(0, 3)));
    const r2 = await send(p, { text: 'back' });
    check('typed "back" from browse reaches main menu', r2.buttons.includes(EN.menu[0]), JSON.stringify(r2.buttons));
  }
  {
    // typed "more" on the LAST page must not strand the customer
    const p = await startEn();
    await send(p, { id: 'browse' });
    await send(p, { id: `page_${LAST}` });
    const r = await send(p, { text: 'more' });
    check('typed "more" on last page still shows products',
      r.rows.some(x => CATALOG.some(c => c.en[0] === x)), JSON.stringify(r.rows));
  }
  {
    // numeric selection maps to what is on screen
    const p = await startEn();
    await send(p, { id: 'browse' });
    const r = await send(p, { text: '1' });
    check('typing "1" opens the first product shown', r.out.includes(CATALOG[0].en[0]), r.out.slice(0, 80));
  }
  {
    // "10" on a 10-row page = the back row -> main menu
    const p = await startEn();
    await send(p, { id: 'browse' });
    const r = await send(p, { text: '10' });
    check('typing "10" on a full page hits the back row', r.buttons.includes(EN.menu[0]), JSON.stringify(r.buttons));
  }

  // === 4. back_list returns to the page you came from ========================
  {
    const p = await startEn();
    await send(p, { id: 'browse' });
    await send(p, { id: `page_2` });
    const sku = CATALOG[16].sku;
    await send(p, { id: sku });
    const r = await send(p, { id: 'back_list' });
    check('back_list returns to page 2, not page 0',
      r.rows.includes(CATALOG[16].en[0]) && !r.rows.includes(CATALOG[0].en[0]),
      JSON.stringify(r.rows.slice(0, 3)));
  }

  // === 5. retry logic untouched =============================================
  {
    const p = await startEn();
    await send(p, { id: 'browse' });
    await send(p, { id: CATALOG[0].sku });
    await send(p, { id: 'order' });               // -> method
    const r1 = await send(p, { text: 'asdfgh' });
    check('method retry 1 re-prompts', /didn't catch that/.test(r1.out));
    const r2 = await send(p, { text: 'qwerty' });
    check('method retry 2 re-prompts', /didn't catch that/.test(r2.out));
    const r3 = await send(p, { text: 'zxcvbn' });
    check('method retry 3 escalates to a human', /Luis/.test(r3.out) && /SMS to owner/.test(r3.out), r3.out.slice(0, 120));
  }

  // === 6. address validation: re-ask once, then accept + flag ===============
  {
    const p = await startEn();
    await send(p, { id: 'browse' });
    await send(p, { id: CATALOG[0].sku });
    await send(p, { id: 'order' });
    await send(p, { id: 'delivery' });
    const r1 = await send(p, { text: 'here' });
    check('bad address re-asked once', /full street address/.test(r1.out), r1.out.slice(0, 100));
    const r2 = await send(p, { text: 'here' });
    check('second bad address accepted, moves to "when"', r2.buttons.includes(EN.today), JSON.stringify(r2.buttons));
  }

  // === 7. faq list also respects the row limit ==============================
  {
    const p = await startEn();
    const r = await send(p, { id: 'faq' });
    check('faq list within 10 rows', r.rows.length <= 10, `${r.rows.length}`);
    check('faq list has exactly one back row', r.rows.filter(x => x === EN.backMenu).length === 1);
  }

  // === 8. spanish parity ====================================================
  {
    const p = newPhone();
    await send(p, { text: 'hola' });
    await send(p, { id: 'lang_es' });
    const r = await send(p, { id: 'browse' });
    check('es: exactly one back row', r.rows.filter(x => x === T.es.backMenu || x === T.es.startOver).length === 1, JSON.stringify(r.rows));
    check('es: spanish product titles', r.rows.includes(CATALOG[0].es[0]));
  }

  console.log = realLog;
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log('   ✗ ' + f)); process.exitCode = 1; }
})();
