# fitroom — open questions, deferrals, untested assumptions

Living doc. Nothing here is settled. Updated as of 2026-08-29.

## Needs revisiting (agreed, not yet redone)

- **Settings (page 7)** — reviewed while tired, needs a full pass. One change already
  forced: with a local server the API key lives in `.env`, so the settings field becomes
  a status indicator, not an input.
- **Fit gallery (page 5b)** — thinnest page in the design. Revisit once a Fit actually
  has 40+ images and sorting/filtering matters.
- **Slot legend in the sidebar** — it describes the 4-angle expanded case, which is now
  the exception rather than the default. Slightly odd where it sits.
- **Over-budget behaviour** — v1 only alerts. The right answer needs more thought.

## Deferred to v2

- **Custom categories** — create / rename / remove / reorder. Merging Eyewear into
  Accessories is the first sign the fixed list will keep being wrong.
- **Look content detection** — auto-list which garments a Look photo contains, to
  populate strike-through display and sharpen override wording. Demoted below two-pass
  override: it improves phrasing and display, not enforcement.
- **Cross-type "hail mary" contact sheets** — when a Pro render is over budget, combine
  items of different categories into one sheet. Pack from the cheap end of the detail
  priority list: socks, then accessories, then headwear, then bag. Never merge two items
  in the same or adjacent body zone (top + mid-layer will blend). Never merge into a Look.
  Deferred because it degrades detail exactly when detail is being asked for, and needs
  testing before it can be trusted. The compositing function is being written to take
  arbitrary groupings so this is a UI addition later, not a rewrite.
- **Auto-packing** — rejected for v1. No silent slot-allocation algorithm.
- **Chat targeting within a Look** — "use only the boots from that look".
- **Start a new Fit from an existing generated image.**
- **Multiple variations per generate** — each is a separate paid call; left out so a
  misclick can't spend $1.
- **Tags for Fits** — flat list for now. Tags age better than folders if grouping is
  ever needed, since a fit can be both "winter" and "work".
- **Vercel deploy + Supabase** — the migration moment. `server.js` routes become
  serverless functions, SQLite becomes Postgres, `library/` becomes object storage.

## Smoke test results (2026-08-29, Flash 1K, $0.47 across 7 calls)

`smoketest.mjs` ran clean on the first attempt — the request shape was right. Outputs in
`smoketest/out/` (gitignored). Inputs: Iron Heart indigo trucker jacket (4 angles), an
orange beanie, grey/red socks, a look photo (same jacket + white tee + light jeans), khaki
chinos as the override bottom.

| # | assumption | result |
|---|---|---|
| 1 | Contact sheets parse | **Verified.** 2x2 labelled sheet of one garment reproduced stitching, red tab, pocket flaps, button count *indistinguishably* from 4 separate refs (t2a vs t2b). Grid lines and burned-in labels were not rendered. A second person appearing in one panel (the side photo was on a model) did not leak. |
| 2 | Cross-type sheets parse | **Verified.** Beanie -> head, socks -> feet from one 2x1 sheet (t3, t6). Hail mary is unblocked. |
| 3 | Prompt-level override holds | **Verified for a distinctive swap** (light jeans -> khaki chinos, t4). Subtle swaps still untested. |
| 4 | `previous_interaction_id` resumes | **Verified at 1K** (t5): same face/pose/outfit, background swapped cleanly. 2K/4K still untested. |
| 5 | Letterbox vs crop | Letterbox used throughout; fidelity was fine. Crop never tested — no reason to. |
| 6 | 14 is a real cap | Still unverified (Lite only). |

### New findings that change the build

- **The Me photo's clothing leaks.** Any body zone the prompt doesn't cover gets filled from
  the person reference (striped shirt in t1/t3/t5, blazer in t3, khakis + brown shoes in t1).
  Fixed in t6 with two prompt lines: *"use reference 1 ONLY for face, hair, skin and body
  proportions; the clothing in it is irrelevant, do not reproduce any of it"* and a default
  for uncovered zones (*"plain white t-shirt and plain dark trousers"*). Now in DESIGN.md
  §7 as steps 1 and 8. With no footwear specified the model rendered him in socks only —
  i.e. the default should be minimal and explicit, not "plausible".
- **Aspect ratio must be sent, every call.** Without it each output picked its own (16:9,
  3:4, 2:3). Worse, a 2x1 sheet input produced a **2-up duplicate** of the figure — the
  model mimicked the sheet layout (t3). Sending `response_format` + "ONE single
  photograph" fixed it (t6).
- **Request shape, verified:** top-level `response_format: { type: "image", aspect_ratio,
  image_size: "1K"|"2K"|"4K", mime_type }`. Uppercase K. Not inside `generation_config`.
- **Response shape, verified:** `id`, `status: "completed"`, `model`, `steps[]` where the
  image is `steps[i].content[j]` with `type: "image"`, `data` (base64), `mime_type`.
  `steps[0]` is a `thought` step carrying a ~1.7MB `signature` blob — don't persist raw
  responses. `usage.output_tokens_by_modality[{modality:"image",tokens:1120}]` at 1K.
  Timing: 7-11s per Flash 1K call.
- **Node:** `server.js` requires >= 22.5 for `node:sqlite`. The nvm default was v20 and
  lacked it; switched to v24 LTS (`nvm install 24 && nvm alias default 24`) on 2026-08-29.
- The smoketest README says a cloud session can't reach the network. This one could.

### Observed during the build (in-app generations, Flash 1K)

- **Strict override works in the app** — 2 passes, pass 2 resumed via `previous_interaction_id`
  and swapped light jeans → khaki chinos while face, pose, jacket and background held.
- **The model invents footwear.** Beanie + jacket + socks with no footwear row selected: the
  smoke test (t6) rendered socks only, the in-app run rendered brown boots that hid the socks.
  Non-deterministic. If socks matter, select footwear too, or say so in Scene.
- The Refine page shows the *whole* chain back to the root, not just the parent line.

## Identity failures from the first two in-app runs (2026-08-29)

Both runs came back as a different man. The garment machinery was never at fault — the
trucker's stitching, the red tab, the beanie's cuff label and the chinos all reproduced
faithfully, and both overrides fired correctly against the Look. Every fault was on the
person side. This is "Still untested #4" arriving, and it arrived as six separate bugs.

**F1 — an 81px face.** Run 1's face reference was the full-body boat photo, 768x1024, face
occupying 81x81px. The generated face was 96px: the model output more facial detail than
it was given, so it invented a person. The app carried the right advice as UI prose
(">=1024px of actual face") and enforced nothing.
*Fixed:* face uploads now go through a crop step that measures the crop in source pixels
and colour-codes it — red under 512, amber under 1024, green above. Red cannot be starred.
Cropping also improves the reference, not only the measurement: an uncropped frame spends
almost all its resolution on background.

**F2 — the same photo sent twice.** Run 1 had one file registered as both `face` and
`pose` — byte-identical, same sha1 — sent as two separate character references. A slot
spent on a duplicate that carried nothing new.
*Fixed:* uploads are hashed; a photo filling two roles is sent once, with both clauses
pointing at the same reference index. The Me page says when this is happening.

**F3 — expression was never specified.** The face clause governed "face, hair, skin and
build"; the pose clause governed "pose, framing and camera angle". Expression fell in the
gap between them, so the model supplied the genre default — a catalogue smile matching no
reference. Same mechanism as the socks-vs-boots footwear nondeterminism already noted
above: unstated means invented.
*Fixed:* an explicit expression clause, placed last, with a per-Fit control
(neutral / slight smile / as in pose ref / unspecified). Defaults to neutral.

**F4 — the scene clause beat the pose clause.** Pose sat at position 2; the trailing
"plain light grey studio background... full body visible" came last and won, producing a
square catalogue stance instead of the referenced pose. Section 7 put pose early on the
"changes go last" principle, which in practice meant scene overrode pose.
*Fixed:* pose, framing and expression moved to the very end, after scene. DESIGN.md §7
rewritten.

**F5 — a fallback selection that looked like a choice.** `genOpts` read
`poses.find(p => p.id === s.pose_id) || poses[0]`, and the Fit had no `pose_id`. A pose
added one minute before the run was never used, and the dropdown displayed the old one as
selected, so nothing looked wrong.
*Fixed:* the picker says "not chosen — using oldest of N" when it is falling back.

**F6 — deleting a Me photo destroyed provenance.** The face used in run 2 was deleted
afterwards; its `image_refs` row points at a file that no longer exists, so MADE FROM for
that image is broken. We designed for deleted *generated* images and forgot deleted
*reference* photos.
*Fixed:* soft-delete. A photo any image cites keeps its row and file, hidden from the
library.

**F7 — the category was missing from the design.** None of the safeguards built so far —
budget meters, packing panel, provenance — could catch bad *input*. DESIGN.md said the app
must speak up if the Face row is empty; nothing covered a Face row full of something
useless. Input quality is now its own concern (DESIGN.md §7a), not a sentence in a
paragraph.

**Still short on identity.** The reshot face photos are 2048x1536, but the face is still
only ~250-280px — about 2% of frame. Better than 81px; a head-and-shoulders crop lands
around 650-780px, in the amber band. Green needs a closer shot.

## Proposed, not built

Agreed in conversation, documented in DESIGN.md, **not implemented**. The literal strings
are here so the wording does not have to be re-derived.

### Setting source: "use the pose photo's setting" checkbox

A third setting source next to Scene text and the studio default (DESIGN.md §7b). Ticking
it disables the Scene field — they answer the same question. Roughly four lines in
`tail()` and one in the identity line of `buildPasses`.

Only two sentences vary by mode. Everything else in the prompt is identical.

**The setting sentence:**

    studio (default)   Plain light grey studio background, even soft frontal lighting.
    scene text         Scene: <the Fit's scene text>.
    pose setting       Reproduce the setting, background and lighting of reference
                       image P exactly — same location, same light, same time of day.

**The negation sentence** — this is the part that needs care:

    studio / scene     The clothing in reference images 1-N is irrelevant — do not
                       reproduce any of it.

    pose setting       From reference image P take the pose, the camera angle, and the
                       setting — its location, background and light. Take nothing else
                       from it. The clothing in reference images 1-N is irrelevant — do
                       not reproduce any of it.

In studio and scene modes, the pose reference has exactly one job and a blanket negation is
unambiguous. In pose-setting mode it has two, and one clause asks the model to reproduce
that photo's world faithfully while another asks it to discard part of that photo. That is
a partial take from a single image — the same instruction shape that leaks on subtle
overrides ("wear this whole outfit except the trousers"). So the wording enumerates what
to take first, closes the boundary with "take nothing else from it", and only then excludes
the clothing. Positive list, then negation, never a bare negation.

**Untested.** The mode-specific negation has never been through a real generation. Expect
the pose photo's clothing to be the thing that leaks if it fails.

**What it does and does not buy.** The setting is *reconstructed*, not copied — you get a
convincing version of that place, not that place. Its larger effect is breaking the
catalogue genre, which is what drags every unstated value toward product-shot convention.
Cost: studio light is the condition under which a garment's true colour and detail are
legible, and golden-hour side light gives that up.

## Open architectural question — anchor images

Should a Fit carry a **base image** that later generations edit, instead of every
generation composing from scratch?

Today every call is an independent draw from 5-7 references, so the man is re-derived from
his face photos every single time. An anchor would invert that: get one image where the
face is right, mark it, and subsequent generations in that Fit edit *it* rather than
rebuild him.

**For.** Identity becomes a one-time problem instead of a per-call one. Consistency within
a Fit — right now every image is an independent draw and the man drifts. Fewer character
references per call, which frees object slots (material on Pro's 6). And it matches the
real working loop, which is *generate, look, swap one item, regenerate* — that is an edit,
not a fresh composition. The machinery already exists: strict override pass 2 is exactly
this, pointed at a generated image.

**Against.** Edits are lossy and chain badly — colour shifts and softening accumulate, so
an anchor needs periodic re-anchoring rather than indefinite chaining. Pose and setting get
frozen: changing either means leaving the anchor and generating fresh. Garment swaps
against a base can leave silhouette ghosts (replacing a bulky jacket with a tee has to
remove volume that is baked in). And the anchor's mistakes are inherited by everything
after it — wrong hands in the anchor means wrong hands all the way down.

**Shape if we do it.** Explicit and promotable, never automatic: generate fresh until one
is right, then pin it as the anchor. Structural changes (pose, setting, the Look itself)
force a fresh generation; garment swaps, expression and refinement edit the anchor.
Re-anchor is one click. **Anchor is not cover** — cover is the best-looking image, anchor
is the one with the best face, and they are frequently not the same picture.

**The catch.** Anchoring amplifies identity quality in both directions. A good anchor makes
every subsequent image reliably him; a bad one makes every subsequent image reliably a
stranger, and consistently so. It raises the stakes on the crop gate rather than relieving
them — it is not a way around needing a proper face reference.

## Still untested

1. Subtle override (dark jeans -> dark jeans).
2. `previous_interaction_id` at 2K/4K — the forum-reported false 404.
3. Pro model at all. Everything above was Flash.
4. Face fidelity with a proper frontal ref — `me.jpg` was a 3/4 turn on a boat and the
   likeness was serviceable, not great.
5. The 14 cap on Lite.

## Known model/API facts (verified from docs, 2026-08)

| model | id | objects | characters | styles | ~$/image |
|---|---|---|---|---|---|
| Nano Banana Pro | `gemini-3-pro-image` | 6 | 5 | 3 | 0.134 (1-2K), 0.24 (4K) |
| Nano Banana 2 | `gemini-3.1-flash-image` | 10 | 4 | - | 0.067 (1K) - 0.151 (4K) |
| Nano Banana 2 Lite | `gemini-3.1-flash-lite-image` | 14 | - | - | 1K only |

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/interactions`
- Reference roles are **inferred from prompt text**, not tagged in the request.
- Multi-turn editing via `previous_interaction_id`.
- Aspect ratios incl. 1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9.
- Practitioner guidance (not Google): face refs >=1024px, even frontal light, neutral
  expression, 4-6 refs optimal. Harsh side shadow is read as permanent bone structure.
  Relighting into a new scene is routine; inconsistent lighting *between* face refs
  causes feature-averaging.
