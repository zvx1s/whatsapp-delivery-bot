// Test harness — walk the whole conversation from a terminal, no Meta needed.
// Usage:  DRY_RUN=1 node scripts/harness.js          (scripted full-order run)
//         DRY_RUN=1 node scripts/harness.js -i       (interactive: type ids/text yourself)
process.env.DRY_RUN = '1';
process.env.DB_PATH = './harness.db';
const fs = require('fs');
try { fs.unlinkSync('./harness.db'); } catch {}
const { handleInbound, onPaid } = require('../src/flow');

const PHONE = '16505550142';
async function say(input, label) {
  console.log(`\n👤 CUSTOMER: ${label || input.id || input.text}`);
  await handleInbound(PHONE, input, 'Ana Reyes');
}

async function scripted() {
  await say({ text: 'hola' }, 'hola (first contact)');
  await say({ id: 'lang_es' }, 'taps Español');
  await say({ id: 'browse' }, 'taps Ver nuestros arreglos');
  await say({ id: 'page_1' }, 'taps Ver más (page 2)');
  await say({ id: 'FS24' }, 'taps Ramo con osito');
  await say({ id: 'order' }, 'taps Ordenar este');
  await say({ id: 'delivery' }, 'taps Entrega');
  await say({ text: '450 Oak St, Springfield' });
  await say({ id: 'today' }, 'taps Hoy');
  await say({ id: 'card_yes' }, 'taps Sí (card message)');
  await say({ text: 'Feliz cumpleaños Mamá, te quiero — Ana' });
  await say({ text: 'Ana Reyes' }, 'gives name -> checkout link should appear');
  console.log('\n💳 [simulating Stripe checkout.session.completed webhook]');
  await onPaid(PHONE, { id: 'cs_test_123', metadata: { phone: PHONE, sku: 'FS24' } });
  await say({ text: 'necesito hablar con alguien' }, 'asks for a human -> handoff');
  await say({ text: 'sigues ahi?' }, 'messages again -> bot must stay SILENT (paused)');
  console.log('\n✅ scripted run complete — silence above this line means the pause works');
}

async function interactive() {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  console.log('Interactive mode. Type plain text, or id:<button/list id> (e.g. id:browse). Ctrl+C to quit.');
  const ask = () => rl.question('\n👤 > ', async (line) => {
    const input = line.startsWith('id:') ? { id: line.slice(3).trim() } : { text: line.trim() };
    await handleInbound(PHONE, input, 'Tester');
    ask();
  });
  ask();
}

(process.argv.includes('-i') ? interactive() : scripted());
