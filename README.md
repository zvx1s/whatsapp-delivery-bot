# Bilingual WhatsApp Ordering Bot

A production-shaped WhatsApp Business ordering bot for small retail businesses.
English and Spanish throughout. Built for a local florist; the conversation engine
is business-agnostic and all customer-facing content lives in one config file.

Runs entirely offline in dry-run mode — no Meta account, no Stripe keys, no phone
needed to try it.

> **Note on the sample config.** This was built for a real florist — an existing
> client — for their actual shop. The shop name, owner names, address and contact
> details in `config/shop.js` have been replaced with an anonymized stand-in, since
> the client never agreed to be named publicly. Everything else is real: the catalog
> structure, the 25 products, the price points, the bilingual copy and the whole
> conversation flow are the working configuration with identifying details swapped
> out — not a toy example.

```bash
npm install
npm test          # 86 assertions
npm run i         # interactive terminal mode

```

Requires Node 18+. `better-sqlite3` compiles a native module on install — if npm
warns that install scripts were blocked, approve it and reinstall:

```bash
npm install-scripts approve better-sqlite3
npm install
```
---

## What it does

- **Bilingual by design.** Every string, product, prompt and error exists in English
  and Spanish. Language is chosen in the first message and persists.
- **Catalog browsing** with pagination that respects Meta's 10-row interactive list limit.
- **Order capture** — item, delivery or pickup, address with validation, date, card
  message, recipient name.
- **Stripe checkout** with webhook signature verification.
- **Order notification** email to the shop.
- **Human handoff** — SMS alert to the owner, plus a web inbox to reply from. The bot
  goes silent on that conversation for two hours so it can't talk over a real person.
- **Forgiving input.** Customers can tap a button, type the label, or type a number.
  Typos, missing accents and partial phrases all resolve.

### No LLM, deliberately

Every price, hour, address and delivery fee comes from config. The bot cannot invent
a number. For a business where a wrong price is a real-world problem, that's a feature.

---

## Architecture

```
config/shop.js      All client-specific content. The only file that changes per business.
src/flow.js         Conversation engine — state machine, input resolution, fuzzy matching.
src/server.js       Express: Meta webhook handshake, inbound handling, web inbox.
src/send.js         Outbound messages. DRY_RUN logs instead of calling the Graph API.
src/store.js        SQLite session store.
src/stripe.js       Checkout sessions and webhook verification.
scripts/            Test suites and harnesses.
```

**Sessions** persist phone, language, current step, in-progress order, and a
`paused_until` timestamp for handoff silencing.

**Webhook handling** returns 200 immediately and dedupes on message ID — otherwise
Meta's retries produce duplicate sends.

---

## Input resolution

Customer input resolves in strict priority order. Fuzzy matching runs **last**, so it
can never override something spelled correctly:

1. Button and list IDs (tapped)
2. Numeric selection matching what's currently on screen
3. Exact label match, normalized
4. Loose intent patterns
5. Damerau-Levenshtein fuzzy match against on-screen labels only

The fuzzy matcher has two guards: a similarity floor, and a **margin rule** — if two
candidates score within 0.10 of each other it refuses to pick and re-offers the list.
Typing `roses` on a catalog with nine rose products returns the list, not a guess.

That behavior is deliberate. Delivering the wrong arrangement is worse for the business
than asking one more question.

---

## Testing

```bash
npm test              # 42 flow assertions + 44 typo assertions
npm run harness       # scripted happy path, printed
npm run replay        # replays the full manual QA checklist
npm run i             # interactive
npm run probe         # prints what the matcher does with ~35 tricky inputs
```

### Bugs these suites caught

Written adversarially — typing garbage, tapping the wrong things, sending input out of
order. Each was found by testing, not by reading the code:

**Pagination.** The last catalog page rendered two back options while pages 0 and 1
rendered **none** — a row-count guard silently dropped the back row whenever a page was
full, leaving customers with no tappable way out of the list. A third bug let a
nonexistent page render an empty list. All three shared one root cause: navigation rows
were given whatever space the products left over.

**Normalization.** `norm()` deleted punctuation instead of replacing it with a space, so
`"Teddy Bear & Roses"` became `teddy bear  roses` — two spaces, which no customer types.
Exact matching was impossible on **17 of 25 product titles**. Fuzzy matching had been
quietly compensating, which is why it went unnoticed.

**Language routing.** The language step had no typo tolerance and treated anything that
wasn't exactly `lang_es` as a vote for English. A Spanish speaker who mistyped got an
English bot with no explanation — a silent failure on the first interaction, for the
majority of this shop's customers.

**Scoring.** Connector words dragged multi-word similarity below threshold;
`"weddigns and evnts"` failed purely because of the `and`.

Every fix was verified by reverting the code and confirming the new assertions actually
fail against the original.

---

## Configuring for a different business

Edit `config/shop.js`. Nothing else should need to change:

- `CATALOG` — products, both languages, prices
- `T.en` / `T.es` — every customer-facing string
- FAQs, hours, address, handoff copy

**Meta's interactive list limits** are enforced: max 10 rows, row titles ≤24 characters,
descriptions ≤72. Page size is set so products plus navigation can never exceed the cap.

---

## Deployment notes

Two things that will bite on a hosted deploy:

**SQLite needs a persistent volume.** Railway and Render wipe the container filesystem
on every deploy. Without a mounted volume, anyone mid-order silently loses their cart
whenever you push. Mount at `/data` and set `DB_PATH=/data/sessions.db`.

**`/inbox` ships without authentication.** Safe while `DRY_RUN=1` because nothing can
send — but it must be locked before a real token goes in, or anyone with the URL can
read customer names and message them as the business.

Avoid free tiers that sleep. Meta retries webhooks it considers slow, and a cold start
turns into duplicate sends.

---

## Status

Built for a local florist with a bilingual customer base. The build was completed and
tested; the project was declined at the pricing stage and never went live, so there are no production metrics to report.

The codebase, test suites and tooling are reusable — the content layer is fully
separated from the engine, so configuring it for a different business is a single file.

Client-identifying details have been anonymized (see the note at the top).

## License

MIT
