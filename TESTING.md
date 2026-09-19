# Testing the conversation flow

Everything below runs in `DRY_RUN` mode. No Meta account, no Stripe keys, no
phone. Outbound messages print to the terminal instead of hitting the Graph API.

## First run

```
cd whatsapp-starter
npm install
```

If `ls` shows a `node_modules` folder, you already have deps — skip `npm install`.

## The commands

| Command | What it does |
|---|---|
| `npm test` | 86 assertions — adversarial input + typo tolerance. Exits non-zero on failure. |
| `npm run harness` | Scripted happy path, Spanish, end to end. Prints, doesn't assert. |
| `npm run replay` | Replays the full manual checklist below automatically. |
| `npm run i` | Interactive. Type as the customer. |
| `npm run test:typos` | Just the typo-tolerance suite (44 assertions). |
| `npm run probe` | Prints what the matcher *does* with ~35 tricky inputs. For eyeballing judgment, not pass/fail. |

Run `npm test` after every change. It's the regression net.
`npm run replay` is the same thing you'd do by hand — useful when you want to
read the actual conversation rather than a pass/fail.

Each command wipes its own DB on boot, so runs never contaminate each other.

---

## Manual interactive checklist

```
npm run i
```

Type plain text as a customer would, or `id:<something>` to simulate tapping a
button or list row.

**Do the handoff test last.** Once it fires, the bot goes silent for 2 hours on
that number and nothing else will respond. Ctrl+C and `npm run i` again to
clear it — the harness wipes the DB on boot.

### 1. Language by typed word
```
hi
english
```

### 2. Typed button labels
```
See our arrangements
```
Shows the product list, not the menu again.

### 3. Number selection
```
1
```
Opens Teddy Bear & Roses, $150.

### 4. Typed label at the product step
```
Order this one
```
Asks delivery or pickup — does not bounce back to the list.

### 5. The rest of the order, typed not tapped
```
Delivery
820 Marshall St
Today
Yes
Happy Birthday Mom
Ana Reyes
```
Ends with a checkout link, $150 + $15 delivery.

### 6. Gibberish
```
I am so cool
```
Apologizes and re-offers. Never loops silently.

### 7. Paging and ids
```
id:browse
id:page_1
id:FS24
id:back_list
```
`back_list` returns to page 1 — the page you were on, not page 0.

### 8. Loose intent
```
id:back_menu
what are your hours
```
Routes to the FAQ list.

### 9. Bad input
```
id:FS99
```

### 10. Spanish, then handoff — LAST
```
Ctrl+C
npm run i
hola
español
Ver nuestros arreglos
2
necesito hablar con alguien
sigues ahi?
```
That last line must produce **nothing**. Silence is the pass.

---

## Browse paging

`PAGE = 8` in `src/flow.js`. 25 products across 4 pages: 8, 8, 8, 1.

Eight is not arbitrary. Meta caps interactive lists at 10 rows. A page needs
room for its products plus `Show more` plus `← Back`, so 8 is the ceiling. At 9,
the back row silently vanishes from any full page and the customer has no
tappable way out of the list.

Every page shows exactly one back option, always the last row.

---

## Typo tolerance

Customers mistype. `wdedings` reaches Weddings & events; `delivry` picks
Delivery; `sunflwer basket` opens the Sunflower Basket; `bodas y evntos` works
in Spanish. Accents are optional — `ubicasion` finds Ubicación.

This is plain edit-distance matching against the labels the shop actually
showed. No model, no network, no invented answers. Prices, hours and delivery
info still come only from `config/shop.js`.

Two guards keep it from guessing wrong, both in `src/flow.js`:

- `MIN_SIM` (0.75) — below this the bot apologizes instead of guessing.
- `MIN_MARGIN` (0.10) — the winner must beat the runner-up by this much.
  `red roses` matches four bouquets almost equally, so the bot re-shows the
  list rather than picking one. That is deliberate: a wrong bouquet delivered
  is worse than one extra tap.

Raise `MIN_SIM` if it ever matches something it shouldn't. Lower it if real
customers get apologized at. Run `npm run test:typos` after changing either.

Fuzzy matching runs **last**, only after exact matching has failed, so it can
never override something a customer spelled correctly.

### Language step

`espanl`, `spanich` and `espnol` all reach Spanish. This matters more than the
other typo paths: the language choice is the first thing that happens, most of
this shop's customers pick Spanish, and the old code treated *anything* that
wasn't exactly `lang_es` as a vote for English. A Spanish speaker who mistyped
got an English bot and no explanation.

If the choice still can't be read, the bot re-asks once in both languages, then
defaults to English on the second failure so nobody can get stuck in a loop.

### Punctuation in labels

`norm()` converts punctuation to a **space**, not to nothing. Deleting it turned
"Teddy Bear & Roses" into `teddy bear  roses` — two spaces, which no customer
ever types — so exact matching was silently impossible on 17 of the 25 titles,
and on the FAQ row "Same-day orders". Fuzzy matching had been quietly covering
for this, which is why it never showed up as a bug.

Connector words shorter than four characters ("and", "y", "de") are ignored when
scoring, because one mistyped connector used to drag a whole phrase below
`MIN_SIM` — `weddigns and evnts` failed purely because of the `and`.

### Free-text steps

At the card-message step the customer is dictating content, not choosing an
option, so option matching is switched off there. A card reading *"para la
persona más importante de mi vida"* used to trigger the human-handoff keyword
`persona` — which dropped the card message and silenced the bot for two hours
in the middle of an order. Now only a message that is *itself* a request for a
person ("hablar con alguien") hands off.

Names and addresses are likewise taken verbatim — a customer called Rose, or
one named "Delivery Jones", still reaches checkout.
