# Smoke test inputs

Drop these into `smoketest/in/`. Everything is optional except `me.jpg` —
tests skip themselves if their inputs are missing, so a partial run is fine.

| file | what it is | used by |
|---|---|---|
| `me.jpg` | a photo of you. The 3/4 turn one is fine for now — face resolution isn't what we're testing. | all tests |
| `garment-front.jpg` | any single garment, front view. A product-page screenshot is perfect. | t1, t2a |
| `garment-back.jpg` | the SAME garment, back | t2a, t2b |
| `garment-side.jpg` | the SAME garment, side | t2a, t2b |
| `garment-detail.jpg` | the SAME garment, close detail (texture, hardware, logo) | t2a, t2b |
| `hat.jpg` | any hat | t3 |
| `socks.jpg` | any socks | t3 |
| `look.jpg` | a photo of a complete outfit on someone else | t4 |
| `bottom.jpg` | trousers, clearly different from the ones in look.jpg | t4 |

Pick a garment with **distinctive detail** for the t2 pair — a pattern, a logo, visible
hardware. A plain black tee tells us nothing about whether detail survived.

## Order of operations

1. Drop in what you can. Tell me, and I'll build `sheet-garment.jpg` and
   `sheet-crosstype.jpg` from them (the composites the app would make in-browser).
2. Put your key in `~/Repos/fitroom/.env` as `GEMINI_API_KEY=...`
3. In macOS Terminal (not the sandbox — it has no network):

       cd ~/Repos/fitroom
       node smoketest.mjs

4. Paste me the console output. I'll read the images out of `smoketest/out/`.

Roughly $0.40 if everything runs.
