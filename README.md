# fitroom

Personal virtual try-on on top of Gemini's image models. Upload photos of yourself and of
garments; generate images of yourself wearing them. Single user, local-first.

Design: `DESIGN.md`. Open questions, deferrals, smoke-test results: `OPEN.md`.

## Run

Needs Node **>= 22.5** (uses the built-in `node:sqlite`). No `npm install` — zero dependencies.

    echo 'GEMINI_API_KEY=...' > .env
    node server.js              # → http://localhost:8787
    PORT=9000 node server.js    # different port

nvm default on this Mac is v24 LTS (set 2026-08-29); `node` on PATH just works.

## Layout

    server.js      HTTP + SQLite + the one Gemini function
    index.html     the whole app
    fitroom.db     SQLite (WAL) — all metadata
    library/       your photos (items + me), plain files
    generated/     output images + the contact sheets that were sent, plain files
    smoketest.mjs  the API assumption tests that gated the build (`node smoketest.mjs`)

Back up = copy `fitroom.db`, `library/`, `generated/`. Or Settings → Export.

## First use

1. **Me** — add at least one face photo (starred) and one pose photo.
2. **Library** — add items by category. One photo each is the normal case; toggle
   *Multiple angles* for a 2×2 contact sheet.
3. **+ New Fit** — add items to the shortlist, click to select, Generate.
4. Click a result → Refine → for edits that chain off that image.
