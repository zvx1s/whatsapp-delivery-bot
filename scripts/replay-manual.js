// Replays the exact manual interactive sequence, in order, to verify it.
process.env.DRY_RUN = '1';
process.env.DB_PATH = './replay.db';
try { require('fs').unlinkSync('./replay.db'); } catch {}
const { handleInbound } = require('../src/flow');

const PHONE = '16505550142';
const line = (l) => l.startsWith('id:') ? { id: l.slice(3).trim() } : { text: l.trim() };

async function run(label, steps) {
  console.log(`\n\n${'='.repeat(70)}\n${label}\n${'='.repeat(70)}`);
  for (const l of steps) {
    console.log(`\n👤 > ${l}`);
    await handleInbound(PHONE, line(l), 'Tester');
  }
}

(async () => {
  await run('SESSION A — steps 1-9 (English)', [
    'hi', 'english',
    'See our arrangements',
    '1',
    'Order this one',
    'Delivery', '820 Marshall St', 'Today', 'Yes', 'Happy Birthday Mom', 'Ana Reyes',
    'I am so cool',
    'id:browse', 'id:page_1', 'id:FS24', 'id:back_list',
    'id:back_menu', 'what are your hours',
    'id:FS99'
  ]);

  // fresh session = the Ctrl+C restart
  try { require('fs').unlinkSync('./replay.db'); } catch {}
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/flow')];
  const flow2 = require('../src/flow');
  console.log(`\n\n${'='.repeat(70)}\nSESSION B — step 10 (Spanish + handoff, restarted)\n${'='.repeat(70)}`);
  for (const l of ['hola', 'español', 'Ver nuestros arreglos', '2', 'necesito hablar con alguien', 'sigues ahi?']) {
    console.log(`\n👤 > ${l}`);
    await flow2.handleInbound(PHONE, line(l), 'Tester');
  }
  console.log('\n\n^ last line must have produced NOTHING');
})();
