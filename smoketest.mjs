#!/usr/bin/env node
// fitroom smoke test — validates the assumptions the app design rests on.
// Run from ~/Repos/fitroom :   node smoketest.mjs
// Needs .env with:  GEMINI_API_KEY=...
//
// NOTE: the request/response shape below is written from Google's REST docs but has
// never been executed. If a call fails, the raw error body is printed and saved —
// that output is what we use to correct it. Nothing here is assumed to work.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const IN = 'smoketest/in';
const OUT = 'smoketest/out';
mkdirSync(OUT, { recursive: true });

// ---------- config ----------
const FLASH = 'gemini-3.1-flash-image';
const PRO   = 'gemini-3-pro-image';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// ---------- key ----------
let KEY = process.env.GEMINI_API_KEY;
if (!KEY && existsSync('.env')) {
  const m = readFileSync('.env', 'utf8').match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/m);
  if (m) KEY = m[1].replace(/^["']|["']$/g, '');
}
if (!KEY) {
  console.error('No GEMINI_API_KEY. Put it in .env as  GEMINI_API_KEY=xxxx');
  process.exit(1);
}

// ---------- helpers ----------
const has = f => existsSync(join(IN, f));
const img = f => ({
  type: 'image',
  data: readFileSync(join(IN, f)).toString('base64'),
  mime_type: f.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
});
const text = t => ({ type: 'text', text: t });

let spent = 0;
const PRICE = { [FLASH]: 0.067, [PRO]: 0.134 };

async function call(name, { model = FLASH, input, previous_interaction_id }) {
  const body = { model, input };
  if (previous_interaction_id) body.previous_interaction_id = previous_interaction_id;

  process.stdout.write(`\n▶ ${name}\n  model=${model} images=${input.filter(p => p.type === 'image').length} ... `);
  const t0 = Date.now();
  let res, raw;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    raw = await res.text();
  } catch (e) {
    console.log(`NETWORK FAIL (${e.message})`);
    return null;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  writeFileSync(join(OUT, `${name}.response.json`), raw);

  if (!res.ok) {
    console.log(`HTTP ${res.status} in ${secs}s`);
    console.log('  ---- raw error ----');
    console.log('  ' + raw.slice(0, 1200).replace(/\n/g, '\n  '));
    console.log('  -------------------');
    return null;
  }

  let json;
  try { json = JSON.parse(raw); } catch { console.log('unparseable JSON — see response file'); return null; }

  // dig out the first image, tolerating shape drift
  let b64 = json?.output_image?.data;
  if (!b64) {
    const steps = json?.steps || [];
    for (const s of steps) for (const c of (s?.content || [])) if (c?.type === 'image' && c?.data) { b64 = c.data; break; }
  }
  if (!b64) {
    console.log(`ok (${secs}s) but NO IMAGE found — see ${name}.response.json`);
    console.log('  top-level keys: ' + Object.keys(json).join(', '));
    return json;
  }

  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  spent += PRICE[model] || 0;
  console.log(`OK ${secs}s → ${file}`);
  console.log(`  interaction id: ${json.id || json.interaction_id || '(none found)'}`);
  return json;
}

const PERSON = 'The person shown in the reference photo of a man. Keep his face, hair and build exactly as shown.';

// ---------- tests ----------
const results = {};

// T1 — baseline. Does any of this work at all?
if (has('me.jpg') && has('garment-front.jpg')) {
  results.t1 = await call('t1-baseline', {
    input: [
      text(`${PERSON} Generate a full-body photograph of him wearing the garment shown in the second reference image. Plain light grey studio background, even soft frontal lighting, standing facing the camera.`),
      img('me.jpg'),
      img('garment-front.jpg'),
    ],
  });
} else console.log('\n⊘ t1 skipped — needs me.jpg + garment-front.jpg');

// T2 — the big one. Four separate refs vs one contact sheet.
const angles = ['garment-front.jpg', 'garment-back.jpg', 'garment-side.jpg', 'garment-detail.jpg'];
if (has('me.jpg') && angles.every(has)) {
  await call('t2a-four-separate-refs', {
    input: [
      text(`${PERSON} Generate a full-body photograph of him wearing the garment shown in reference images 2 through 5, which show the same single garment from the front, the back, the side, and a close detail. Reproduce its colour, pattern and hardware exactly. Plain light grey studio background, three-quarter turn.`),
      img('me.jpg'), ...angles.map(img),
    ],
  });
} else console.log('\n⊘ t2a skipped — needs me.jpg + all four garment angle files');

if (has('me.jpg') && has('sheet-garment.jpg')) {
  await call('t2b-contact-sheet', {
    input: [
      text(`${PERSON} The second reference image is a labelled contact sheet showing ONE single garment photographed from several angles — each panel is captioned with the angle it shows. Treat all panels as the same garment. Generate a full-body photograph of him wearing that garment. Reproduce its colour, pattern and hardware exactly. Plain light grey studio background, three-quarter turn.`),
      img('me.jpg'), img('sheet-garment.jpg'),
    ],
  });
} else console.log('\n⊘ t2b skipped — needs sheet-garment.jpg (I build this from your angle photos)');

// T3 — cross-type sheet. Two unrelated garments in one image.
if (has('me.jpg') && has('sheet-crosstype.jpg')) {
  await call('t3-crosstype-sheet', {
    input: [
      text(`${PERSON} The second reference image is a labelled contact sheet containing TWO DIFFERENT garments, each panel captioned with what it is. Generate a full-body photograph of him wearing both, each on the correct part of his body as its caption indicates. Plain light grey studio background, standing facing the camera.`),
      img('me.jpg'), img('sheet-crosstype.jpg'),
    ],
  });
} else console.log('\n⊘ t3 skipped — needs sheet-crosstype.jpg (I build this from hat.jpg + socks.jpg)');

// T4 — prompt-level override.
if (has('me.jpg') && has('look.jpg') && has('bottom.jpg')) {
  await call('t4-override', {
    input: [
      text(`${PERSON} Reference image 2 shows a complete outfit worn by someone else. Generate a full-body photograph of HIM wearing that complete outfit. IMPORTANT EXCEPTION: do not use the trousers shown in reference image 2. He wears the trousers shown in reference image 3 instead. Everything else comes from reference image 2. Plain light grey studio background.`),
      img('me.jpg'), img('look.jpg'), img('bottom.jpg'),
    ],
  });
} else console.log('\n⊘ t4 skipped — needs look.jpg + bottom.jpg');

// T5 — does previous_interaction_id actually resume?
const prevId = results.t1?.id || results.t1?.interaction_id;
if (prevId) {
  await call('t5-refine-resume', {
    previous_interaction_id: prevId,
    input: [text('Same image, but change the background to a warm late-afternoon outdoor setting. Keep his face, pose and clothing exactly as they are.')],
  });
} else console.log('\n⊘ t5 skipped — no interaction id from t1');

// ---------- summary ----------
console.log(`\n${'─'.repeat(60)}`);
console.log(`Outputs in ${OUT}/  ·  approx spend $${spent.toFixed(3)}`);
console.log('Send me the console output above plus the contents of smoketest/out/.');
