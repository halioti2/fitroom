# fitroom — notes for Claude Code

Read `DESIGN.md` then `OPEN.md` before changing anything. `DESIGN.md` is the intended
design and carries the reasoning; `OPEN.md` is the running record of findings, deferrals
and untested assumptions. Both are kept current — update them in the same commit as the
code they describe.

## DESIGN.md is not a description of the code

Anything in `DESIGN.md` marked **PROPOSED — NOT BUILT** is agreed design that has not been
implemented. Do not assume it exists; do not implement it silently either. The literal
prompt strings for proposed prompt changes live in `OPEN.md` under "Proposed, not built"
so the wording does not have to be reinvented.

## Invariants — breaking these has cost real money

- **Zero npm dependencies.** Node >= 22.5 for the built-in `node:sqlite`. No package.json,
  no install step. Keep it that way.
- **One Gemini function.** `gemini()` in `server.js` is the only thing that knows the API
  exists. It becomes a serverless route at the Vercel step; nothing else should have to
  change.
- **Whatever must win goes last in the prompt.** Late instructions dominate. A trailing
  scene clause once overrode an explicit pose instruction sitting in sentence three
  (OPEN.md F4). See `DESIGN.md` §7 for the order and why it was changed.
- **Anything unstated gets invented, as the genre default.** The prompt describes a studio
  product shot, so an unstated expression became a catalogue smile and unstated footwear
  became sneakers. Expression, gaze and every garment slot get a value or a default
  sentence. Never leave one open.
- **Clothing in a person reference is never used.** Face, body and pose photos are of him
  wearing something and it leaks without an explicit negation. Unconditional — it does not
  depend on the setting mode.
- **Identity is measured, not advised.** Face photos go through the crop gate; under 512px
  cannot be starred. Advice in UI prose is not a safeguard — an 81px face shipped once
  while the page displayed ">=1024px" guidance. See §7a.
- **Never hard-delete anything `image_refs` cites.** Soft-delete. `image_refs` is a
  provenance *snapshot*, not a join — an image must still report what made it after the
  Fit has changed. Same for `scene_used` and `prompt` on `images`.
- **One photo in two roles is one reference.** Deduped by sha1. Sending it twice costs a
  character slot and adds nothing.
- **Object and character budgets are separate pools.** Garments never compete with face /
  body / pose. One category row with a selection = one object slot.

## Testing

The API is only reachable from the real macOS shell. **A cloud Claude session cannot make a
Gemini call** — its egress proxy blocks `generativelanguage.googleapis.com`, and the Linux
VM mounted on this Mac has no network at all. So a cloud session can write and read code
but cannot verify a generation; ask the user to run it.

`node smoketest.mjs` is the API assumption harness. Results are in `OPEN.md`.

Generations cost real money (Flash 1K ~$0.067, Pro 2K ~$0.134). Never generate to "check
something" without saying what it will cost first.

## Conventions

- No build step, no framework, no bundler. `index.html` is the whole client.
- Prefer editing in place over rewriting a file.
- Terminology is fixed: **Item**, **Look** (an item category of whole-outfit photos),
  **Fit** (the named combination + its images), **Me** (face / body / pose), **Shortlist**.
  `DESIGN.md` §1.
