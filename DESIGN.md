# fitroom — design

Personal virtual try-on. Upload photos of yourself and of garments; generate images of
yourself wearing them. Single user, local-first, eventually deployable to Vercel.

Companion doc: `OPEN.md` (deferrals, revisit items, untested assumptions, API facts).

---

## 1. Terminology

Fixed vocabulary. Use these words in code and UI.

- **Item** — one garment. Belongs to exactly one category. Has 1–4 reference photos.
- **Look** — a category like any other, whose items are whole-outfit reference photos.
  An input, never a workspace.
- **Fit** — a named saved combination: a shortlist of items, a selection from it, and
  every image it has generated. Duplicable under a new name. Output accumulates to the
  Fit even as its items change.
- **Me** — your own photos, in three roles: **face** (identity), **body** (proportions),
  **pose** (stance, framing, camera angle).
- **Shortlist** — per-Fit, per-category candidate set. The middle state between "in your
  library" and "selected for generation".
- **Contact sheet** — several photos composited into one labelled image, to spend one
  reference slot instead of several.

## 2. Categories

Layer-ordered. `Look` sits first, above a divider, because it spans slots rather than
occupying one.

    Look | Headwear · Top · Mid-layer · Outerwear · Full-body · Bottom ·
           Socks · Footwear · Bag · Accessories

Eyewear was merged into Accessories: under the row model, separate rows cost separate
slots, so glasses/watch/chain in one row is the whole point. Bag stays separate — large,
silhouette-changing, worth its own slot. Full-body (dress/jumpsuit) excludes Top+Bottom
when selected. User-defined categories are v2.

Slot order is fixed: **front, side, then top *or* back, then detail.** Slot 3 is the only
one that varies by item — garments have a back, hats/shoes/socks/accessories have a top.
"Back" never appears in slot 2, so the emblem and every sheet read the same way.

    Garments (Look, Top, Mid-layer, Outerwear, Full-body, Bottom, Bag)
               front / side / back / detail
    Headwear, Socks, Footwear, Accessories
               front / side / top  / detail
    (labels editable per item — e.g. Footwear slot 3 → SOLE)

## 3. Stack

    ~/Repos/fitroom/
      server.js      Node >= 22.5, ZERO npm dependencies (node:sqlite is built in)
      index.html     the whole app, one file
      .env           GEMINI_API_KEY
      fitroom.db     SQLite
      library/       garment + me photos, as real files
      generated/     output images, as real files

Run: `node server.js`, open `localhost:PORT`.

**Why a server and not a static page.** Chrome blocks IndexedDB on `file://`, so a local
server was forced anyway. Given one, SQLite beats IndexedDB: photos are real files you
can see, drop into, and back up; the database is one copyable file; the API key lives
server-side, which kills CORS and matches the eventual deploy.

**Why not Supabase yet.** It solves multi-device sync and phone access — problems that
don't exist for one person on one Mac. It becomes the obvious answer at the Vercel step,
when routes become serverless functions, SQLite becomes Postgres, and `library/` becomes
object storage.

## 4. Data model

```sql
items(id, category, title, prompt_notes, my_notes, multi_angle, created_at)
item_photos(id, item_id, slot /*0-3*/, label, filename)
me_photos(id, role /*face|body|pose*/, title, starred, star_order, filename)
fits(id, name, scene, cover_image_id, created_at, updated_at)
fit_shortlist(fit_id, item_id, selected /*bool*/, added_at)
images(id, fit_id, seq, filename, model, resolution, aspect, cost,
       interaction_id, parent_image_id, scene_used, passes, created_at)
image_refs(image_id, kind, label)   -- provenance snapshot, frozen at generation time
settings(key, value)
```

`image_refs` is a **snapshot**, not a join. An image must still report what made it after
the Fit's items have changed. Same reason `scene_used` is stored per image.

Routes:

    GET    /api/state                 everything the UI needs on load
    POST   /api/items                 create / update
    POST   /api/items/:id/photo       upload into a slot
    DELETE /api/items/:id
    POST   /api/me/photo
    POST   /api/fits                  create / rename / duplicate
    POST   /api/fits/:id/shortlist    add / remove / select
    POST   /api/generate
    POST   /api/refine
    GET    /library/*  /generated/*   static

Every Gemini call goes through **one function**. That function is what becomes a
serverless route later; nothing else should know the API exists.

## 5. Reference budget

Two independent pools. They do not compete.

| model | objects | characters | styles |
|---|---|---|---|
| `gemini-3-pro-image` | 6 | 5 | 3 |
| `gemini-3.1-flash-image` | 10 | 4 | — |

**Objects** = garments. **Characters** = your face/body/pose photos.

The central simplification: **one category row with a selection = one object slot.**
Multi-select within a row composites into a single sheet. So slots used = rows selected.

Characters: pose (1, mandatory) + body (0–1, opt-in) + starred faces, filling what's
left, dropped in reverse star order. On Pro that's up to 4 faces; on Flash, 3. Body is
first to drop when switching to Flash. The app never asks — it shows what it used.

Over budget: **alert only, never auto-pack.** Name the rows in play; disable Generate.
Note that Flash's 10 slots means over-budget is essentially a Pro-only condition.

## 6. Contact sheets

Composited in-browser with `<canvas>`, labels burned in as text.

- 1 photo → sent uncomposited. No sheet.
- 2 → 2×1.  3 or 4 → 2×2, empty cell left blank.
- Multi-item (one row, several items) → one cell per item, labelled with
  `Category · Title`.
- Fit strategy on drop: **letterbox, never crop.** Cropping to fill will guillotine a
  sleeve or a shoe toe, which is the opposite of the point.

Write the compositing function to take **arbitrary groupings** from the start — the
cross-type hail mary (see `OPEN.md`) then becomes a UI addition rather than a rewrite.

## 7. Prompt construction

Order matters, and **an earlier version of this section had it wrong.** It put pose at
position 2 and scene at 7, on the principle that changes go last — which in practice meant
the trailing scene text overrode the pose instruction entirely. Late instructions dominate,
so whatever must win goes at the end.

    1. Person       "Reference image 1 shows a man. Use it ONLY for his face, hair, skin
                    and body proportions. The clothing in it is irrelevant — do not
                    reproduce any of it."   (smoke test: without this, it leaks)
    2. Look         if present: "wear the complete outfit shown in reference N"
    3. Items        in layer order, each named with category + title + prompt_notes
    4. Sheets       "reference N is a labelled contact sheet; each panel is captioned"
    5. Exceptions   overrides: "do NOT use the trousers from reference N; they come
                    from reference M instead"
    6. Setting      one of three sources — see 7b — never more than one
    7. Defaults     uncovered zones get an explicit minimal default (plain white tee /
                    plain dark trousers) — the model invents otherwise
    8. POSE         "reference P shows the pose, framing and camera angle to reproduce —
                    match his stance, weight, arm and head position, the camera angle
                    and the crop"
    9. EXPRESSION   explicit, always, never left unstated
    10. Output      "Generate ONE single photograph, full body visible."

**Anything unstated gets invented, as the genre default.** The prompt describes a studio
product shot, so an unspecified expression became a catalogue smile and unspecified
footwear became sneakers (or socks, or boots — it is not deterministic). Expression, gaze
and every garment slot either get a value or get a default sentence.

**One photo in two roles is one reference.** Identical bytes are detected by sha1 and sent
once, with both clauses pointing at the same index. Sending it twice costs a character
slot and adds nothing.

**The clothing in a person reference is never used. Ever.** Face, body and pose photos are
of him wearing something, and without an explicit negation those garments leak into the
output — verified in the smoke test (a striped shirt and a blazer arrived uninvited). The
negation is unconditional and does not depend on the setting source: whatever background
mode is in play, every person reference contributes face, build, stance or setting only,
and its clothes are explicitly excluded. When the setting comes *from* the pose photo,
this becomes a partial take from one image — keep its place and its light, reject its
clothes — which is the same instruction shape that leaks on subtle overrides. Word it as
two separate sentences, and expect to test it.

Every call also sends `response_format: { type: "image", aspect_ratio, image_size }` —
without it the model picks its own ratio and, given a 2×1 sheet, will mirror the layout
into a 2-up output.

Reference roles are **inferred from prompt text** — the API has no role tagging. So every
image must be referred to explicitly and specifically. Naming a garment's details is the
main lever on fidelity.

### 7a. Input quality is a first-class concern

No prompt rescues a bad reference, and the app's job is to refuse one rather than describe
one. Identity is measured, not advised:

- Face photos are cropped on upload and the crop is measured in source pixels.
- Under 512px cannot be starred; 1024px is the target.
- The Generate bar states the identity being sent — how many faces, and the smallest —
  and warns *before* the call.

**Override is prompt-level, i.e. persuasion, not data.** Distinctive swaps hold; subtle
ones leak. The stronger remedy is **strict override** — two passes: generate in the Look,
then `previous_interaction_id` to swap the item against that result. Editing one image is
far more constrained than composing from conflicting references. Opt-in, doubles cost,
only offered when a Look and a same-category item are both selected.

### 7b. Where the setting comes from

Three sources, mutually exclusive, resolved in this order:

| source | when | what it writes |
|---|---|---|
| **Scene text** | the Fit's Scene box has content | `Scene: <text>.` |
| **Pose photo's setting** *(PROPOSED — NOT BUILT)* | the "use the pose photo's setting" box is ticked | `Reproduce the setting, background and lighting of reference P exactly — same location, same light, same time of day.` plus a modified negation — exact strings in OPEN.md, "Proposed, not built" |
| **Studio** (default) | neither | `Plain light grey studio background, even soft frontal lighting.` |

Ticking the pose-setting box disables the Scene field; they are answers to the same
question.

**The setting clause is the most powerful sentence in the prompt, and not because of the
background.** It selects a genre, and the genre supplies every value the prompt leaves
unstated. "Plain grey studio, even soft frontal lighting, full body visible" is the
description of a product catalogue shot, so an unspecified stance becomes a catalogue
stance, an unspecified expression becomes a catalogue smile, unspecified footwear becomes
clean sneakers. This is why a trailing scene clause was able to override an explicit pose
instruction (OPEN.md F4): it was not competing background-against-background, it was
establishing an idiom that brought its own stance along.

Consequences worth knowing before choosing:

- **The pose photo's setting is reconstructed, not copied.** Generation draws a new
  picture; no pixel of the reference survives. You get a convincing version of that place,
  not that place. Fine for "outdoors, warm evening light"; uncanny for somewhere
  recognisable.
- **Studio is the right default for judging clothes.** Even frontal light on a neutral
  ground is the condition under which a garment's true colour and detail are legible.
  Golden-hour side light shifts indigo and warms metal hardware — you lose the ability to
  tell faithful reproduction from approximate reproduction. Catalogues look that way for a
  reason.
- **The pose setting is the cheap 80% of the edit path.** If the goal is genuinely *his*
  background, the answer is to edit a base image rather than describe a setting. That is
  an open architectural question — see "Anchor images" in OPEN.md.

## 8. Pages

Mockups are the shared vocabulary — build against these, not against prose.

    1   Library            items by category
    2   Item editor        single drop zone, "Multiple angles" toggle -> 2x2 grid
    3   Me                 face / body / pose, starring, character-slot meter
    4   Fits index         flat grid, search + sort, no folders
    5   Fit builder        row per category: search half | shortlist half
    5b  Fit gallery        Images tab - thin, see OPEN.md
    6   Image detail       provenance + refine chain
    7   Settings           needs a revision pass, see OPEN.md

The left nav is identical on every page. Category counts are live. The SLOTS legend is
the only coloured thing in the app: a `▣▣▣▣` emblem with four coloured squares, and four
label lines each tinted to match its position. Card badges stay monochrome (filled dark /
hollow grey) so colour doesn't compete for attention on every card.

    position 1 front       blue
    position 2 side        amber
    position 3 top·back    teal     (the one that varies by item)
    position 4 detail      violet

### Page 1 — Library

```
┌──────────────┬────────────────────────────────────────────────┐
│  FITROOM     │  BOTTOM                          [ + New item ]│
│              │                                                │
│  Me       8  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │
│  Fits    12  │  │ ██████ │ │ ██████ │ │ ██████ │ │ ██████ │  │
│              │  │ ██████ │ │ ██████ │ │ ██████ │ │ ██████ │  │
│ [+ New Fit ] │  ├────────┤ ├────────┤ ├────────┤ ├────────┤  │
│              │  │Levi 501│ │Blk chino│ │Carhartt│ │Grey swt│  │
│  ITEMS       │  │ ▣▣▣▣  │ │ ▣▣▢▢   │ │ ▣▣▣▣  │ │ ▣▢▢▢  │  │
│   Look     6 │  └────────┘ └────────┘ └────────┘ └────────┘  │
│  ──────────  │                                                │
│   Headwear 1 │                                                │
│   Top      7 │                                                │
│   Mid-layer2 │                                                │
│   Outerwear3 │                                                │
│   Full-body0 │                                                │
│ › Bottom   4 │                                                │
│   Socks    1 │                                                │
│   Footwear 5 │                                                │
│   Bag      2 │                                                │
│   Accessory6 │                                                │
│              │                                                │
│  ▣▣▣▣        │                                                │
│  SLOTS       │                                                │
│  1 front     │                                                │
│  2 side      │                                                │
│  3 top·back  │                                                │
│  4 detail    │                                                │
│              │                                                │
│  ⚙ Settings  │                                                │
└──────────────┴────────────────────────────────────────────────┘
```

`Look` sits above a divider — it spans slots rather than occupying one, so keeping it
first stops it reading as "the garment above headwear". The badge shows which angle slots
are filled, not a count: `▣▣▢▢` reads as "has front and side, missing back/top and detail"
without counting. Hovering shows that item's actual labels.

### Page 2 — Item editor, default state

One photo is the realistic case, so this is what you meet by default. No empty cells, no
implied homework.

```
┌──────────────┬─────────────────────────────────────────────────┐
│  FITROOM     │ ‹ Bottom     [ Levi 501              ]          │
│              │              Group [ Bottom        ▾ ]  [Delete]│
│  Me       8  │                                                 │
│  Fits    12  │  REFERENCE PHOTO      Multiple angles [ ○── ]   │
│              │  ┌───────────────────────────────┐              │
│ [+ New Fit ] │  │ ████████████████████████   ✕  │              │
│              │  │ ████████████████████████      │              │
│  ITEMS       │  │ ████████████████████████      │              │
│   Look     6 │  │ ████████████████████████      │              │
│  ──────────  │  ├───────────────────────────────┤              │
│   Headwear 1 │  │ FRONT                       ✎ │              │
│   Top      7 │  └───────────────────────────────┘              │
│   Mid-layer2 │                                                 │
│   Outerwear3 │  + Add prompt notes     + Add my notes          │
│   Full-body0 │                                                 │
│ › Bottom   4 │                                     [ Save ]    │
│   Socks    1 │                                                 │
│   ...        │                                                 │
└──────────────┴─────────────────────────────────────────────────┘
```

### Page 2 — Item editor, multiple angles on

```
│  REFERENCE PHOTOS           Multiple angles  [ ──● ]  on   │
│  ┌───────────────┬───────────────┐                         │
│  │ ███████████ ✕ │ ███████████ ✕ │                         │
│  │ ███████████   │ ███████████   │                         │
│  │ ███████████   │ ███████████   │                         │
│  ├───────────────┼───────────────┤                         │
│  │ FRONT       ✎ │ SIDE        ✎ │                         │
│  ├───────────────┼───────────────┤                         │
│  │               │               │                         │
│  │  drop photo   │  drop photo   │                         │
│  │  or paste     │               │                         │
│  ├───────────────┼───────────────┤                         │
│  │ BACK        ✎ │ DETAIL      ✎ │                         │
│  └───────────────┴───────────────┘                         │
│                 ships as 2×1                               │
│                                                            │
│  + Add prompt notes     + Add my notes                     │
│                                                            │
│  [ Preview contact sheet ]                    [ Save ]     │
```

The grid **is** the contact sheet — what you arrange is literally the image the model
receives. Labels come pre-filled per category; `✎` is optional, and editing "DETAIL" to
"HEM DETAIL" is editing the prompt, since the label is burned into the sheet.

`ships as 2×1` updates live. `Preview contact sheet` appears only above one photo.
Toggling back off **keeps** the photos and remembers them — it shows slot 1 and restores
the rest when re-enabled. Never destroy photos on a toggle.

Notes fields are collapsed links until used, and labelled so it's never ambiguous which
one reaches the model:

```
│  PROMPT NOTES            sent with the prompt   │
│  ┌───────────────────────────────────────┐      │
│  │ raw denim, straight leg, stacks at    │      │
│  │ the ankle, copper hardware            │      │
│  └───────────────────────────────────────┘      │
│                                                 │
│  MY NOTES                        never sent     │
│  ┌───────────────────────────────────────┐      │
│  │ levi.com/501-original/rigid           │      │
│  │ W32 L32 · $98 · bought Mar 2026       │      │
│  └───────────────────────────────────────┘      │
```

URLs in My Notes render as clickable links. Empty prompt notes append nothing at all —
no stray blank line.

### Page 3 — Me

```
┌──────────────┬─────────────────────────────────────────────────┐
│  FITROOM     │  ME                             [ + Add photo ] │
│              │                                                 │
│  Me       8  │  FACE                    identity · starred     │
│  Fits    12  │  ┌────────┐ ┌────────┐ ┌────────┐              │
│              │  │ ██████ │ │ ██████ │ │ ██████ │              │
│ [+ New Fit ] │  │ ██████ │ │ ██████ │ │ ██████ │              │
│              │  ├────────┤ ├────────┤ ├────────┤              │
│  ITEMS       │  │front ★ │ │45°   ★ │ │profile★│              │
│   Look     6 │  └────────┘ └────────┘ └────────┘              │
│  ──────────  │   3 starred                                     │
│   Headwear 1 │                                                 │
│   Top      7 │  BODY                    proportions · optional │
│   Mid-layer2 │  ┌────────┐ ┌────────┐                          │
│   Outerwear3 │  │ ██████ │ │ ██████ │                          │
│   Full-body0 │  ├────────┤ ├────────┤                          │
│ › Bottom   4 │  │full-01 │ │full-02 │                          │
│   Socks    1 │  └────────┘ └────────┘                          │
│   Footwear 5 │                                                 │
│   Bag      2 │  POSE               pick one when generating    │
│   Accessory6 │  ┌────────┐ ┌────────┐ ┌────────┐              │
│              │  │ ██████ │ │ ██████ │ │ ██████ │              │
│  ▣▣▣▣        │  ├────────┤ ├────────┤ ├────────┤              │
│  SLOTS       │  │standing│ │3/4 turn│ │looking │              │
│  1 front     │  │front   │ │        │ │up      │              │
│  2 side      │  └────────┘ └────────┘ └────────┘              │
│  3 top·back  │                                                 │
│  4 detail    │  CHARACTER SLOTS                                │
│              │  ▓▓▓▓▓  5 of 5 (Pro)                            │
│  ⚙ Settings  │  3 face + 1 body + 1 pose                       │
│              │  On Flash you get 4 — body drops first          │
└──────────────┴─────────────────────────────────────────────────┘
```

Face photos are never contact-sheeted — likeness is the first casualty of resolution loss.
If the Face row is empty the app must say so plainly rather than let you generate with no
identity reference and wonder why the result isn't you.

**Reference photo guidance to surface in the UI**: even frontal light, neutral expression,
no glasses/hats/hands on the face, nothing past ~60° of turn, ≥1024px of actual face. A
harsh side shadow is read as permanent bone structure, not as lighting. Inconsistent
lighting *between* face refs causes feature-averaging — a coherent set beats a set of
individually better photos.

### Page 4 — Fits index

```
┌──────────────┬─────────────────────────────────────────────────┐
│  FITROOM     │  FITS                             [ + New Fit ] │
│              │  ┌──────────────┐         Sort [ Recent     ▾ ] │
│  Me       8  │  │ search…      │                               │
│  Fits    12  │  └──────────────┘                               │
│              │                                                 │
│ [+ New Fit ] │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│              │  │ ████████ │ │ ████████ │ │ ████████ │        │
│  ITEMS       │  │ ████████ │ │ ████████ │ │ ████████ │        │
│   Look     6 │  │ ████████ │ │ ████████ │ │ ████████ │        │
│  ──────────  │  ├──────────┤ ├──────────┤ ├──────────┤        │
│   Headwear 1 │  │Fall work │ │Wedding   │ │Sat casual│        │
│   Top      7 │  │5 items   │ │4 items   │ │3 items   │        │
│   Mid-layer2 │  │7 images  │ │2 images  │ │11 images │        │
│   Outerwear3 │  │2d ago  ⋯ │ │1w ago  ⋯ │ │3w ago  ⋯ │        │
│   Full-body0 │  └──────────┘ └──────────┘ └──────────┘        │
│ › Bottom   4 │                                                 │
│   Socks    1 │  ┌──────────┐ ┌──────────┐                     │
│   Footwear 5 │  │   ┌───┐  │ │ ████████ │                     │
│   Bag      2 │  │   │ + │  │ │ ████████ │                     │
│   Accessory6 │  │   └───┘  │ │ ████████ │                     │
│              │  ├──────────┤ ├──────────┤                     │
│  ▣▣▣▣        │  │Interview │ │Beach     │                     │
│  SLOTS       │  │3 items   │ │6 items   │                     │
│  1 front     │  │no images │ │4 images  │                     │
│  ...         │  │today   ⋯ │ │2mo ago ⋯ │                     │
│              │  └──────────┘ └──────────┘                     │
│  ⚙ Settings  │                                                 │
└──────────────┴─────────────────────────────────────────────────┘
```

Two counts, because they answer different questions: **items** is the recipe, **images**
is how much you've generated against it. "3 items, no images" is a legitimate state and
shows a `+` placeholder instead of a cover. `⋯` is Rename / Duplicate / Delete. Cover
defaults to the most recent generation, overridable from page 6.

### Page 5 — Fit builder

```
┌──────┬─────────────────────────────────────────────────────────────────┐
│FITRM │ ‹ Fits   [ Fall workwear        ]     Build │ Images 9      ⋯   │
│      │                                                                 │
│Me   8│ ┌ LOOK ───── search ──────────┬ SHORTLIST ───────────────────┐  │
│Fits12│ │ ┌──┐┌──┐┌──┐┌──┐┌──┐  ›     │ ┌──────┐┌──────┐             │  │
│      │ │ │██││██││██││██││██│        │ │████ ✕││████ ✕│             │  │
│[+Fit]│ │ └+─┘└+─┘└+─┘└+─┘└+─┘        │ │  ✓   ││      │             │  │
│      │ └─────────────────────────────┴──────────────────────────────┘  │
│ITEMS │ ┌ HEADWEAR ─ empty ──────────────────────────────────── + ──┐   │
│Look 6│ └──────────────────────────────────────────────────────────┘   │
│──────│ ┌ TOP ────── search ──────────┬ SHORTLIST ───────────────────┐  │
│Headw1│ │ ┌──┐┌──┐┌──┐┌──┐┌──┐  ›     │ ┌──────┐┌──────┐┌──────┐     │  │
│Top  7│ │ │██││██││██││██││██│        │ │████ ✕││████ ✕││████ ✕│     │  │
│Mid  2│ │ └+─┘└+─┘└+─┘└+─┘└+─┘        │ │  ✓   ││      ││      │     │  │
│Outer3│ └─────────────────────────────┴──────────────────────────────┘  │
│Full 0│ ┌ MID-LAYER ─ search ─────────┬ SHORTLIST ───────────────────┐  │
│Bttm 4│ │ ┌──┐┌──┐                    │                              │  │
│Socks1│ │ │██││██│                    │   nothing selected           │  │
│Foot 5│ │ └+─┘└+─┘                    │                              │  │
│Bag  2│ └─────────────────────────────┴──────────────────────────────┘  │
│Acc  6│ ┌ OUTERWEAR ─ search ─────────┬ SHORTLIST ───────────────────┐  │
│      │ │ ┌──┐┌──┐┌──┐                │ ┌──────┐┌──────┐             │  │
│▣▣▣▣  │ │ │██││██││██│                │ │████ ✕││████ ✕│             │  │
│SLOTS │ │ └+─┘└+─┘└+─┘                │ │  ✓   ││      │             │  │
│1front│ └─────────────────────────────┴──────────────────────────────┘  │
│2side │ ┌ BOTTOM ──── search ─────────┬ SHORTLIST ───────────────────┐  │
│3top  │ │ ┌──┐┌──┐┌──┐┌──┐  ›         │ ┌──────┐┌──────┐┌──────┐     │  │
│4detai│ │ │██││██││██││██│            │ │████ ✕││████ ✕││████ ✕│     │  │
│      │ │ └+─┘└+─┘└+─┘└+─┘            │ │      ││  ✓   ││      │     │  │
│⚙ Set │ │                             │      overrides the look      │  │
│      │ └─────────────────────────────┴──────────────────────────────┘  │
│      │ ┌ SOCKS ───── empty ─────────────────────────────────── + ──┐   │
│      │ └──────────────────────────────────────────────────────────┘   │
│      │ ┌ FOOTWEAR ── search ─────────┬ SHORTLIST ───────────────────┐  │
│      │ │ ┌──┐┌──┐┌──┐┌──┐┌──┐  ›     │ ┌──────┐                     │  │
│      │ │ │██││██││██││██││██│        │ │████ ✕│                     │  │
│      │ │ └+─┘└+─┘└+─┘└+─┘└+─┘        │ │  ✓   │                     │  │
│      │ └─────────────────────────────┴──────────────────────────────┘  │
│      │ ┌ ACCESSORIES  search ────────┬ SHORTLIST ───────────────────┐  │
│      │ │ ┌──┐┌──┐┌──┐┌──┐┌──┐  ›     │ ┌──────┐┌──────┐┌──────┐     │  │
│      │ │ │██││██││██││██││██│        │ │████ ✕││████ ✕││████ ✕│     │  │
│      │ │ └+─┘└+─┘└+─┘└+─┘└+─┘        │ │  ✓   ││  ✓   ││  ✓   │     │  │
│      │ │                             │  3 selected → 1 sheet        │  │
│      │ └─────────────────────────────┴──────────────────────────────┘  │
│      │┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈│
│      │ ┌ RESULTS ────────────────────────────────────────────────────┐ │
│      │ │ ┌────┐ ┌────┐ ┌────┐ ┌────┐            click to enlarge    │ │
│      │ │ │ ⟳  │ │████│ │████│ │████│                                │ │
│      │ │ │ …  │ │ #8 │ │ #7 │ │ #6 │                                │ │
│      │ │ └────┘ └────┘ └────┘ └────┘                                │ │
│      │ └─────────────────────────────────────────────────────────────┘ │
│      │ ══ GENERATE ══════════════════════════════════════════════════  │
│      │  Pose [ standing 3/4 ▾ ]   Body [──●] full-01    Face 3★        │
│      │  Quality ( ● Flash  ○ Pro )      objects 6/10   characters 4/4  │
│      │  Strict override [ ○── ] off       look + 1 override · 2 passes │
│      │  Scene [ outdoors, overcast daylight, full body              ]  │
│      │  1K ▾                                    ~$0.067  [ Generate ▶] │
└──────┴─────────────────────────────────────────────────────────────────┘
```

The dotted line is where scrolling stops: rows scroll above it, results and generate stay
pinned. `⟳` is a generation in flight; it becomes the newest image and the strip shifts
right. `overrides the look` appears whenever a Look is also selected — a statement about
what you did, needing no knowledge of the Look's contents.

Shortlist card affordances:

```
 ┌────────┐    ✕  removes from the shortlist
 │██████ ✕│    body click toggles ✓ selection
 │████████│    removing a selected item deselects it on the way out
 ├────────┤
 │Carhartt│
 │   ✓    │
 └────────┘
```

Strict override on, and the over-budget state:

```
│  Strict override [ ──● ] on        look + 1 override · 2 passes │
│  1K ▾                                    ~$0.134  [ Generate ▶] │

│  ⚠ 8 rows selected · Pro holds 6 objects                        │
│    look, top, mid, outerwear, bottom, socks, footwear, access.  │
│    Deselect 2 rows, or switch to Flash (10)      [ Generate ▶ ] │
```

Naming the rows means the user isn't counting them. Generate stays disabled until it fits.

### Page 5b — Fit gallery (Images tab)

```
┌──────┬─────────────────────────────────────────────────────────────────┐
│FITRM │ ‹ Fits   [ Fall workwear        ]     Build │ Images 9      ⋯   │
│      │                                                                 │
│Me   8│                                        Sort [ Newest        ▾ ] │
│Fits12│                                                                 │
│      │  ┌───────┐┌───────┐┌───────┐┌───────┐┌───────┐                  │
│[+Fit]│  │███████││███████││███████││███████││███████│                  │
│      │  │███████││███████││███████││███████││███████│                  │
│ITEMS │  │███████││███████││███████││███████││███████│                  │
│Look 6│  ├───────┤├───────┤├───────┤├───────┤├───────┤                  │
│──────│  │#9   ★ ││#8  ↑#7││#7     ││#6  ↑#5││#5     │                  │
│Headw1│  │Pro 2K ││Flash  ││Flash  ││Flash  ││Flash  │                  │
│Top  7│  └───────┘└───────┘└───────┘└───────┘└───────┘                  │
│ ...  │                                                                 │
└──────┴─────────────────────────────────────────────────────────────────┘
```

`★` is the cover, `↑#7` means refined from #7. Three ways into an image, by recency: the
dock for the last few, this tab for all, page 6's prev/next once inside one.

### Page 6 — Image detail

```
┌──────┬─────────────────────────────────────────────────────────────────┐
│FITRM │ ‹ Fall workwear            #7 of 9          ‹ prev     next ›   │
│      │                                                                 │
│Me   8│ ┌────────────────────────────┐ ┌ MADE FROM ───────────────────┐│
│Fits12│ │                            │ │  Pose    standing 3/4        ││
│      │ │                            │ │  Body    full-01             ││
│[+Fit]│ │                            │ │  Face    3 starred           ││
│      │ │                            │ │                              ││
│ITEMS │ │        [  image  ]         │ │  Look    street-shot-04      ││
│Look 6│ │                            │ │  Top     cream henley        ││
│──────│ │                            │ │  Outer   Carhartt Detroit    ││
│Headw1│ │                            │ │  Bottom  Levi 501  override  ││
│Top  7│ │                            │ │  Access  sheet · glasses +   ││
│Mid  2│ └────────────────────────────┘ │          watch + chain       ││
│Outer3│                                │                              ││
│Full 0│  Flash · 1K · 2 passes         │ SCENE                        ││
│Bttm 4│  Aug 29, 2:14pm · $0.134       │  outdoors, overcast          ││
│Socks1│                                │  daylight, full body         ││
│Foot 5│  [ Download ] [ Cover ] [ 🗑 ] │                              ││
│Bag  2│                                │  ↑ refined from #6           ││
│Acc  6│                                └──────────────────────────────┘│
│      │ ┌ REFINE ───────────────────────────────────────────────────┐  │
│▣▣▣▣  │ │  tuck the henley in                              → #6     │  │
│SLOTS │ │  warmer light, late afternoon                    → #7     │  │
│1front│ │                                                           │  │
│2side │ │  ┌─────────────────────────────────────┐   ~$0.067        │  │
│3top  │ │  │                                     │   [  Send  ]     │  │
│4detai│ │  └─────────────────────────────────────┘                  │  │
│      │ └───────────────────────────────────────────────────────────┘  │
│⚙ Set │ ┌ IMAGES ───────────────────────────────────────────────────┐  │
│      │ │ ┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐                             │  │
│      │ │ │██││██││██││██││██││██││▓▓│                             │  │
│      │ │ └──┘└──┘└──┘└──┘└──┘└──┘└──┘                             │  │
│      │ │  #1  #2  #3  #4  #5  #6  #7 ←                            │  │
│      │ └───────────────────────────────────────────────────────────┘  │
└──────┴─────────────────────────────────────────────────────────────────┘
```

MADE FROM is the debugging surface — whether accessories got sheeted, whether the override
was in play, which model, and the scene text *actually used* rather than what the Scene
box says today. Every item name links back to its editor.

Refine never overwrites: each line makes a new image, lineage shown both ways (`↑ refined
from #6` here, `→ #7` on the line that made it). Cost sits next to Send, because a refine
is a full-price call and it's easy to forget that when it feels like chat.

**Failure case to build now:** if `previous_interaction_id` fails, do not error — resend
the image as a fresh reference and say so inline: *"couldn't resume, sent the image as a
reference instead."* Weaker continuity, still working, and the user knows which mode
produced the result. Deleting an image in a chain is allowed; children read "refined from
a deleted image".

### Lightbox (over page 5, from the results dock)

```
┌ #9 ───────────────────────────────────────────────── ✕ ┐
│  ┌──────────────────────────┐   Flash · 1K · $0.067    │
│  │                          │   Bottom  Levi 501       │
│  │        [ image ]         │   Outer   Carhartt       │
│  │                          │   Access  sheet ×3       │
│  └──────────────────────────┘                          │
│   ‹ #8        [ Refine → ]  [ Download ]        #10 ›  │
└────────────────────────────────────────────────────────┘
```

Enough provenance to see what changed. `Refine →` is the door to page 6; otherwise you
close it and keep clicking shortlist items. This is the primary loop — page 6 is for when
something is wrong, not for every iteration.

### Page 7 — Settings (draft, needs revision)

```
┌──────┬─────────────────────────────────────────────────────────────────┐
│FITRM │  SETTINGS                                                       │
│      │                                                                 │
│Me   8│  GEMINI API KEY                        ✓ loaded from .env       │
│Fits12│  Server-side. Never sent to the browser.                        │
│      │                                                                 │
│[+Fit]│  DEFAULTS                                                       │
│      │  Quality      ( ● Flash    ○ Pro )                              │
│ITEMS │  Resolution   [ 1K              ▾ ]                             │
│Look 6│  Aspect       [ 2:3 portrait    ▾ ]                             │
│──────│                                                                 │
│Headw1│  CATEGORIES                             [ Edit slot labels ]    │
│Top  7│  Look · Headwear · Top · Mid-layer · Outerwear · Full-body ·    │
│Mid  2│  Bottom · Socks · Footwear · Bag · Accessories                  │
│Outer3│                                                                 │
│Full 0│  SPEND                                                          │
│Bttm 4│  This month    $4.82          127 generations                   │
│Socks1│  Flash 1K  118 × $0.067       Pro 2K  9 × $0.134                │
│Foot 5│  Warn me past [ $25  ] per month                    [ ✓ ]       │
│Bag  2│                                                                 │
│Acc  6│  STORAGE                                                        │
│      │  ▓▓▓▓▓▓░░░░░░░░   412 MB · 38 items · 9 fits · 94 images        │
│▣▣▣▣  │  [ Export library .zip ]     [ Import ]                         │
│SLOTS │                                                                 │
│ ...  │  ──────────────────────────────────────────────────────────     │
│      │  [ Clear all data ]                                             │
│⚙ Set │                                                                 │
└──────┴─────────────────────────────────────────────────────────────────┘
```

Aspect defaults to **2:3 portrait** — most output is a standing full-body shot, and
squarer ratios spend pixels on wall. The key is a status line, not an input: it lives in
`.env` server-side. Spend tracking is a real guardrail, not decoration — a careless
afternoon at Pro/4K is $20.

## 9. Build order

0. **`smoketest.mjs` — DONE 2026-08-29, all passed.** Results and the two findings that
   changed §7 are in `OPEN.md`.
1. `server.js` + schema + static serving + the single Gemini function — **done**
2. Pages 1–2 — load the wardrobe — **done**
3. Page 3 — Me — **done**
4. Pages 4–5 + generate — **done, usable app**
5. Results dock + lightbox — **done**
6. Page 6 — refine, strict override — **done, both verified against the API**
7. Page 7 — settings, export/import (`.tar.gz`, no zip in node's stdlib) — **done**

Built 2026-08-29. Deviations from the spec above, all small: `fits.settings` (JSON) remembers
each fit's pose/body/quality/resolution/aspect/strict; `images.prompt`, `refine_text`,
`resume_mode`, `usage` columns added for page 6's debugging surface; a `person_word`
setting ("man") feeds the prompt. Export is `.tar.gz` rather than `.zip`. See `README.md`.

## 10. Decisions worth not re-litigating

- **A Claude Artifact can't host this.** Published artifacts run under a CSP that blocks
  outbound fetch to any host. No available runtime capability calls a third-party image
  API. Not a preference — a wall.
- **Look is an input category, not a workspace.** An earlier design made Look the
  container that held items and accumulated output; that role belongs to Fit.
- **No auto-packing.** A silent slot-allocation algorithm was rejected. Sheets happen
  only because the user multi-selected.
- **Look content detection is low value.** Knowing what a Look photo contains improves
  prompt wording and enables strike-through display. It does not improve enforcement.
  Two-pass strict override does, and needs no detection.
- **One photo per item is the realistic default.** The 2×2 grid is opt-in. This inverts
  what compositing is *for*: not packing angles of one garment, but packing distinct
  garments into a 6-slot budget.
- **Faces are never contact-sheeted.** Likeness is the first thing lost to resolution,
  and the character pool is roomy enough that there's no pressure to compress.
