#!/usr/bin/env node
// fitroom — local server. Node >= 22.5 (node:sqlite). Zero npm dependencies.
//   node server.js            → http://localhost:8787
//   PORT=9000 node server.js
//
// Layout: see DESIGN.md §3–4. Every Gemini call goes through gemini() and nothing else
// knows the API exists — that function is what becomes a serverless route later.

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync, readdirSync, createReadStream } from 'node:fs';
import { join, extname, basename, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname ?? '.');
const PORT = Number(process.env.PORT || 8787);
const LIB = join(ROOT, 'library');
const GEN = join(ROOT, 'generated');
for (const d of [LIB, GEN]) mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- key
let KEY = process.env.GEMINI_API_KEY;
if (!KEY && existsSync(join(ROOT, '.env'))) {
  const m = readFileSync(join(ROOT, '.env'), 'utf8').match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/m);
  if (m) KEY = m[1].replace(/^["']|["']$/g, '');
}

// ---------------------------------------------------------------- models
// Verified 2026-08-29 (OPEN.md). Prices are $/image; 2K Flash is interpolated — usage
// tokens are stored per image so this can be corrected later.
export const MODELS = {
  flash: { id: 'gemini-3.1-flash-image', label: 'Flash', objects: 10, characters: 4,
           price: { '1K': 0.067, '2K': 0.101, '4K': 0.151 } },
  pro:   { id: 'gemini-3-pro-image',     label: 'Pro',   objects: 6,  characters: 5,
           price: { '1K': 0.134, '2K': 0.134, '4K': 0.24 } },
};
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// ---------------------------------------------------------------- db
const db = new DatabaseSync(join(ROOT, 'fitroom.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    prompt_notes TEXT NOT NULL DEFAULT '', my_notes TEXT NOT NULL DEFAULT '',
    multi_angle INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS item_photos (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL,
    UNIQUE(item_id, slot));
  CREATE TABLE IF NOT EXISTS me_photos (
    id TEXT PRIMARY KEY, role TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    starred INTEGER NOT NULL DEFAULT 0, star_order INTEGER NOT NULL DEFAULT 0,
    filename TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS fits (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, scene TEXT NOT NULL DEFAULT '',
    cover_image_id TEXT, settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS fit_shortlist (
    fit_id TEXT NOT NULL REFERENCES fits(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    selected INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL, PRIMARY KEY(fit_id, item_id));
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY, fit_id TEXT NOT NULL REFERENCES fits(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, filename TEXT NOT NULL, model TEXT NOT NULL, resolution TEXT NOT NULL,
    aspect TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0, interaction_id TEXT,
    parent_image_id TEXT, scene_used TEXT NOT NULL DEFAULT '', passes INTEGER NOT NULL DEFAULT 1,
    prompt TEXT NOT NULL DEFAULT '', refine_text TEXT NOT NULL DEFAULT '',
    resume_mode TEXT NOT NULL DEFAULT '', usage TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS image_refs (
    image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
const q = (sql) => db.prepare(sql);
const now = () => new Date().toISOString();
const uid = () => randomUUID().replace(/-/g, '').slice(0, 12);
const shaOf = (buf) => createHash('sha1').update(buf).digest('hex');

// migrations — added after the first two runs came back as a stranger (OPEN.md, Findings).
// sha     : identical bytes in two roles must be sent once, not twice
// face_px : the measured face crop, so the app can refuse to send 81 pixels of you
// deleted : soft-delete, so provenance on generated images keeps resolving
{
  const cols = new Set(q('PRAGMA table_info(me_photos)').all().map(c => c.name));
  if (!cols.has('sha'))     db.exec("ALTER TABLE me_photos ADD COLUMN sha TEXT NOT NULL DEFAULT ''");
  if (!cols.has('face_px')) db.exec('ALTER TABLE me_photos ADD COLUMN face_px INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('deleted')) db.exec('ALTER TABLE me_photos ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
  for (const r of q("SELECT id, filename FROM me_photos WHERE sha=''").all())
    try { q('UPDATE me_photos SET sha=? WHERE id=?').run(shaOf(readFileSync(join(LIB, r.filename))), r.id); } catch {}
}

const DEFAULT_SETTINGS = { quality: 'flash', resolution: '1K', aspect: '2:3', budget_warn: '25', budget_on: '1' };
function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of q('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

// ---------------------------------------------------------------- files
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
               '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
function saveDataUrl(dir, prefix, dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw httpErr(400, 'expected a data: URL image');
  const ext = EXT[m[1]] || '.jpg';
  const name = `${prefix}-${uid()}${ext}`;
  const buf = Buffer.from(m[2], 'base64');
  writeFileSync(join(dir, name), buf);
  return { filename: name, mime: m[1], sha: shaOf(buf) };
}
function fileToPart(dir, filename) {
  const ext = extname(filename).toLowerCase();
  return { type: 'image', data: readFileSync(join(dir, filename)).toString('base64'), mime_type: MIME[ext] || 'image/jpeg' };
}
function rm(dir, filename) { try { unlinkSync(join(dir, filename)); } catch {} }
function dirSize(dir) { let n = 0; for (const f of readdirSync(dir)) { try { n += statSync(join(dir, f)).size; } catch {} } return n; }

// ---------------------------------------------------------------- gemini — THE function
// parts: [{type:'text',text}|{type:'image',data,mime_type}]. Returns {ok, id, image:{data,mime}, usage, raw?, status, error}
async function gemini({ model, parts, previous_interaction_id, aspect, resolution }) {
  if (!KEY) return { ok: false, status: 0, error: 'No GEMINI_API_KEY in .env' };
  const body = {
    model,
    input: parts,
    response_format: { type: 'image', aspect_ratio: aspect, image_size: resolution, mime_type: 'image/jpeg' },
  };
  if (previous_interaction_id) body.previous_interaction_id = previous_interaction_id;
  let res, raw;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    raw = await res.text();
  } catch (e) { return { ok: false, status: 0, error: `network: ${e.message}` }; }
  if (!res.ok) {
    let msg = raw.slice(0, 600);
    try { msg = JSON.parse(raw).error?.message || msg; } catch {}
    return { ok: false, status: res.status, error: msg };
  }
  let json; try { json = JSON.parse(raw); } catch { return { ok: false, status: 502, error: 'unparseable response' }; }
  let image = json.output_image?.data ? { data: json.output_image.data, mime: json.output_image.mime_type } : null;
  if (!image) for (const s of json.steps || []) for (const c of s.content || []) if (c.type === 'image' && c.data) { image = { data: c.data, mime: c.mime_type }; break; }
  if (!image) return { ok: false, status: 502, error: 'response had no image', usage: json.usage };
  return { ok: true, id: json.id, image, usage: json.usage || {} };
}

// ---------------------------------------------------------------- state
function state() {
  const items = q('SELECT * FROM items ORDER BY created_at DESC').all();
  const photos = q('SELECT * FROM item_photos ORDER BY slot').all();
  for (const it of items) it.photos = photos.filter(p => p.item_id === it.id);
  const me = q('SELECT * FROM me_photos WHERE deleted=0 ORDER BY role, star_order, created_at').all();
  const fits = q('SELECT * FROM fits ORDER BY updated_at DESC').all();
  const sl = q('SELECT * FROM fit_shortlist ORDER BY added_at').all();
  const images = q('SELECT * FROM images ORDER BY fit_id, seq').all();
  const refs = q('SELECT * FROM image_refs ORDER BY idx').all();
  for (const im of images) { im.refs = refs.filter(r => r.image_id === im.id); im.usage = JSON.parse(im.usage || '{}'); }
  for (const f of fits) {
    f.shortlist = sl.filter(s => s.fit_id === f.id);
    f.images = images.filter(i => i.fit_id === f.id);
    f.settings = JSON.parse(f.settings || '{}');
  }
  const month = now().slice(0, 7);
  const spend = q('SELECT model, resolution, COUNT(*) n, SUM(cost) cost FROM images WHERE created_at LIKE ? GROUP BY model, resolution').all(month + '%');
  return {
    items, me, fits, settings: getSettings(), models: MODELS, key_loaded: !!KEY,
    spend: { month, rows: spend, total: spend.reduce((a, r) => a + r.cost, 0), count: spend.reduce((a, r) => a + r.n, 0) },
    storage: { bytes: dirSize(LIB) + dirSize(GEN), items: items.length, fits: fits.length, images: images.length },
  };
}

// ---------------------------------------------------------------- routes
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/state', () => state());

// items --------------------------------------------------------------------
route('POST', '/api/items', (_, body) => {
  const t = now();
  if (body.id) {
    const cur = q('SELECT * FROM items WHERE id=?').get(body.id); if (!cur) throw httpErr(404, 'no such item');
    q('UPDATE items SET category=?, title=?, prompt_notes=?, my_notes=?, multi_angle=?, updated_at=? WHERE id=?')
      .run(body.category ?? cur.category, body.title ?? cur.title, body.prompt_notes ?? cur.prompt_notes,
           body.my_notes ?? cur.my_notes, body.multi_angle != null ? +!!body.multi_angle : cur.multi_angle, t, body.id);
    if (Array.isArray(body.labels)) for (const [slot, label] of body.labels.entries())
      q('UPDATE item_photos SET label=? WHERE item_id=? AND slot=?').run(String(label ?? ''), body.id, slot);
    return { id: body.id };
  }
  const id = uid();
  q('INSERT INTO items VALUES (?,?,?,?,?,?,?,?)').run(id, body.category || 'top', body.title || '', body.prompt_notes || '', body.my_notes || '', +!!body.multi_angle, t, t);
  return { id };
});
route('POST', '/api/items/:id/photo', (p, body) => {
  const it = q('SELECT id FROM items WHERE id=?').get(p.id); if (!it) throw httpErr(404, 'no such item');
  const slot = Math.max(0, Math.min(3, +body.slot || 0));
  const prev = q('SELECT * FROM item_photos WHERE item_id=? AND slot=?').get(p.id, slot);
  if (prev) { rm(LIB, prev.filename); q('DELETE FROM item_photos WHERE id=?').run(prev.id); }
  if (!body.data) return { removed: true };            // no data = clear the slot
  const { filename } = saveDataUrl(LIB, 'item', body.data);
  const id = uid();
  q('INSERT INTO item_photos VALUES (?,?,?,?,?)').run(id, p.id, slot, body.label || prev?.label || '', filename);
  q('UPDATE items SET updated_at=? WHERE id=?').run(now(), p.id);
  return { id, filename };
});
route('DELETE', '/api/items/:id', (p) => {
  for (const ph of q('SELECT filename FROM item_photos WHERE item_id=?').all(p.id)) rm(LIB, ph.filename);
  q('DELETE FROM items WHERE id=?').run(p.id);
  return { ok: true };
});

// me -----------------------------------------------------------------------
route('POST', '/api/me/photo', (_, body) => {
  if (body.id) {                                       // update title / star / role
    const cur = q('SELECT * FROM me_photos WHERE id=?').get(body.id); if (!cur) throw httpErr(404, 'no such photo');
    let starOrder = cur.star_order;
    if (body.starred != null && +!!body.starred !== cur.starred)
      starOrder = body.starred ? (q('SELECT COALESCE(MAX(star_order),0) m FROM me_photos WHERE starred=1').get().m + 1) : 0;
    q('UPDATE me_photos SET title=?, role=?, starred=?, star_order=?, face_px=? WHERE id=?')
      .run(body.title ?? cur.title, body.role ?? cur.role, body.starred != null ? +!!body.starred : cur.starred, starOrder,
           body.face_px != null ? Math.max(0, +body.face_px) : cur.face_px, body.id);
    return { id: body.id };
  }
  if (!['face', 'body', 'pose'].includes(body.role)) throw httpErr(400, 'role must be face|body|pose');
  const { filename, sha } = saveDataUrl(LIB, 'me', body.data);
  const id = uid();
  const dupes = q('SELECT id, role, title FROM me_photos WHERE sha=? AND deleted=0').all(sha);
  q('INSERT INTO me_photos (id, role, title, starred, star_order, filename, created_at, sha, face_px, deleted) VALUES (?,?,?,?,?,?,?,?,?,0)')
    .run(id, body.role, body.title || '', 0, 0, filename, now(), sha, Math.max(0, +body.face_px || 0));
  return { id, filename, sha, duplicates: dupes };
});
route('DELETE', '/api/me/photo/:id', (p) => {
  const cur = q('SELECT filename FROM me_photos WHERE id=?').get(p.id);
  if (!cur) return { ok: true };
  // If any generated image cites this photo, keep the row and the file — a hard delete
  // leaves MADE FROM pointing at nothing. Hide it instead.
  const used = q('SELECT COUNT(*) c FROM image_refs WHERE filename=?').get(cur.filename).c;
  if (used) { q('UPDATE me_photos SET deleted=1, starred=0 WHERE id=?').run(p.id); return { ok: true, soft: true, used }; }
  rm(LIB, cur.filename); q('DELETE FROM me_photos WHERE id=?').run(p.id);
  return { ok: true, soft: false };
});

// fits ---------------------------------------------------------------------
route('POST', '/api/fits', (_, body) => {
  const t = now();
  if (body.duplicate_of) {
    const src = q('SELECT * FROM fits WHERE id=?').get(body.duplicate_of); if (!src) throw httpErr(404, 'no such fit');
    const id = uid();
    q('INSERT INTO fits VALUES (?,?,?,?,?,?,?)').run(id, body.name || `${src.name} copy`, src.scene, null, src.settings, t, t);
    for (const s of q('SELECT * FROM fit_shortlist WHERE fit_id=?').all(src.id))
      q('INSERT INTO fit_shortlist VALUES (?,?,?,?)').run(id, s.item_id, s.selected, t);
    return { id };
  }
  if (body.id) {
    const cur = q('SELECT * FROM fits WHERE id=?').get(body.id); if (!cur) throw httpErr(404, 'no such fit');
    const settings = body.settings ? JSON.stringify({ ...JSON.parse(cur.settings || '{}'), ...body.settings }) : cur.settings;
    q('UPDATE fits SET name=?, scene=?, cover_image_id=?, settings=?, updated_at=? WHERE id=?')
      .run(body.name ?? cur.name, body.scene ?? cur.scene, 'cover_image_id' in body ? body.cover_image_id : cur.cover_image_id, settings, t, body.id);
    return { id: body.id };
  }
  const id = uid();
  q('INSERT INTO fits VALUES (?,?,?,?,?,?,?)').run(id, body.name || 'Untitled fit', body.scene || '', null, JSON.stringify(body.settings || {}), t, t);
  return { id };
});
route('DELETE', '/api/fits/:id', (p) => {
  for (const im of q('SELECT filename FROM images WHERE fit_id=?').all(p.id)) rm(GEN, im.filename);
  q('DELETE FROM fits WHERE id=?').run(p.id);
  return { ok: true };
});
route('POST', '/api/fits/:id/shortlist', (p, body) => {
  const fit = q('SELECT id FROM fits WHERE id=?').get(p.id); if (!fit) throw httpErr(404, 'no such fit');
  const { item_id, action } = body;                    // add | remove | select | deselect
  if (action === 'add') q('INSERT OR IGNORE INTO fit_shortlist VALUES (?,?,0,?)').run(p.id, item_id, now());
  else if (action === 'remove') q('DELETE FROM fit_shortlist WHERE fit_id=? AND item_id=?').run(p.id, item_id);
  else if (action === 'select' || action === 'deselect')
    q('UPDATE fit_shortlist SET selected=? WHERE fit_id=? AND item_id=?').run(action === 'select' ? 1 : 0, p.id, item_id);
  else throw httpErr(400, 'action must be add|remove|select|deselect');
  q('UPDATE fits SET updated_at=? WHERE id=?').run(now(), p.id);
  return { ok: true };
});

// images -------------------------------------------------------------------
route('DELETE', '/api/images/:id', (p) => {
  const im = q('SELECT * FROM images WHERE id=?').get(p.id); if (!im) return { ok: true };
  rm(GEN, im.filename);
  for (const r of q('SELECT filename FROM image_refs WHERE image_id=? AND filename LIKE ?').all(p.id, 'sheet-%')) rm(GEN, r.filename);
  q('UPDATE fits SET cover_image_id=NULL WHERE cover_image_id=?').run(p.id);
  q('DELETE FROM images WHERE id=?').run(p.id);
  return { ok: true };
});

// generate -----------------------------------------------------------------
// body: { fit_id, quality:'flash'|'pro', resolution, aspect, scene_used,
//         passes: [ { prompt, refs:[ {kind,label,detail,source} ] }, ... ] }
//   source: 'library:<filename>' | 'data:image/jpeg;base64,...' (a browser-built sheet)
//   Pass 2+ resumes pass 1 via previous_interaction_id.
// Records ONE image row (the final pass), with every ref from every pass as provenance.
route('POST', '/api/generate', async (_, body) => {
  const fit = q('SELECT * FROM fits WHERE id=?').get(body.fit_id); if (!fit) throw httpErr(404, 'no such fit');
  const M = MODELS[body.quality] || MODELS.flash;
  const resolution = body.resolution || '1K', aspect = body.aspect || '2:3';
  if (!Array.isArray(body.passes) || !body.passes.length) throw httpErr(400, 'no passes');

  // enforce the budget server-side too
  for (const pass of body.passes) {
    const objects = pass.refs.filter(r => ['item', 'sheet', 'look', 'override'].includes(r.kind)).length;
    const chars = pass.refs.filter(r => ['face', 'body', 'pose'].includes(r.kind)).length;
    if (objects > M.objects) throw httpErr(400, `${objects} object references; ${M.label} holds ${M.objects}`);
    if (chars > M.characters) throw httpErr(400, `${chars} character references; ${M.label} holds ${M.characters}`);
  }

  const savedRefs = []; let prevId = null, cost = 0, usage = [], result = null, resume_mode = '';
  for (const [pi, pass] of body.passes.entries()) {
    const parts = [{ type: 'text', text: pass.prompt }];
    for (const [ri, r] of pass.refs.entries()) {
      let filename = '';
      if (r.source?.startsWith('library:')) { filename = r.source.slice(8); parts.push(fileToPart(LIB, basename(filename))); }
      else if (r.source?.startsWith('generated:')) { filename = r.source.slice(10); parts.push(fileToPart(GEN, basename(filename))); }
      else if (r.source?.startsWith('data:')) { const s = saveDataUrl(GEN, 'sheet', r.source); filename = s.filename; parts.push(fileToPart(GEN, filename)); }
      savedRefs.push({ idx: pi * 100 + ri, kind: r.kind, label: r.label || '', detail: r.detail || '', filename });
    }
    let res = await gemini({ model: M.id, parts, previous_interaction_id: prevId, aspect, resolution });
    if (!res.ok && prevId && result) {
      // resume failed → fall back: resend the previous pass's image as a reference, say so.
      resume_mode = 'reference';
      parts.splice(1, 0, { type: 'image', data: result.image.data, mime_type: result.image.mime || 'image/jpeg' });
      parts[0].text = `The first reference image is the photograph to edit. Keep everything about it exactly the same except as instructed. ${pass.prompt}`;
      res = await gemini({ model: M.id, parts, aspect, resolution });
    }
    if (!res.ok) { for (const r of savedRefs) if (r.filename.startsWith('sheet-')) rm(GEN, r.filename); throw httpErr(res.status || 502, res.error); }
    result = res; prevId = res.id; cost += M.price[resolution] ?? 0; usage.push(res.usage);
  }

  const seq = (q('SELECT COALESCE(MAX(seq),0) m FROM images WHERE fit_id=?').get(fit.id).m) + 1;
  const id = uid(), filename = `${fit.id}-${String(seq).padStart(3, '0')}-${id}.jpg`;
  writeFileSync(join(GEN, filename), Buffer.from(result.image.data, 'base64'));
  q(`INSERT INTO images (id,fit_id,seq,filename,model,resolution,aspect,cost,interaction_id,parent_image_id,scene_used,passes,prompt,refine_text,resume_mode,usage,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, fit.id, seq, filename, body.quality || 'flash', resolution, aspect, cost, result.id, null, body.scene_used || '',
         body.passes.length, body.passes.map(p => p.prompt).join('\n\n--- pass ---\n\n'), '', resume_mode, JSON.stringify(usage), now());
  for (const r of savedRefs) q('INSERT INTO image_refs VALUES (?,?,?,?,?,?)').run(id, r.idx, r.kind, r.label, r.detail, r.filename);
  q('UPDATE fits SET updated_at=?, cover_image_id=COALESCE(cover_image_id, ?) WHERE id=?').run(now(), id, fit.id);
  return { id, seq, filename, cost, resume_mode };
});

// refine -------------------------------------------------------------------
// body: { image_id, text, quality?, resolution?, aspect? }  → new image, parent = image_id
route('POST', '/api/refine', async (_, body) => {
  const parent = q('SELECT * FROM images WHERE id=?').get(body.image_id); if (!parent) throw httpErr(404, 'no such image');
  const M = MODELS[body.quality || parent.model] || MODELS.flash;
  const resolution = body.resolution || parent.resolution, aspect = body.aspect || parent.aspect;
  const text = (body.text || '').trim(); if (!text) throw httpErr(400, 'empty refine text');

  let resume_mode = 'resume';
  let res = parent.interaction_id
    ? await gemini({ model: M.id, parts: [{ type: 'text', text }], previous_interaction_id: parent.interaction_id, aspect, resolution })
    : { ok: false, status: 0, error: 'no interaction id' };
  if (!res.ok) {
    resume_mode = 'reference';
    const parts = [
      { type: 'text', text: `The reference image is the photograph to edit. Keep the person, pose, clothing and framing exactly the same except as instructed. ${text}` },
      fileToPart(GEN, parent.filename),
    ];
    res = await gemini({ model: M.id, parts, aspect, resolution });
  }
  if (!res.ok) throw httpErr(res.status || 502, res.error);

  const seq = (q('SELECT COALESCE(MAX(seq),0) m FROM images WHERE fit_id=?').get(parent.fit_id).m) + 1;
  const id = uid(), filename = `${parent.fit_id}-${String(seq).padStart(3, '0')}-${id}.jpg`;
  writeFileSync(join(GEN, filename), Buffer.from(res.image.data, 'base64'));
  const cost = M.price[resolution] ?? 0;
  q(`INSERT INTO images (id,fit_id,seq,filename,model,resolution,aspect,cost,interaction_id,parent_image_id,scene_used,passes,prompt,refine_text,resume_mode,usage,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, parent.fit_id, seq, filename, body.quality || parent.model, resolution, aspect, cost, res.id, parent.id, parent.scene_used,
         1, parent.prompt, text, resume_mode, JSON.stringify([res.usage]), now());
  // provenance carries over from the parent
  for (const r of q('SELECT * FROM image_refs WHERE image_id=?').all(parent.id))
    q('INSERT INTO image_refs VALUES (?,?,?,?,?,?)').run(id, r.idx, r.kind, r.label, r.detail, r.filename);
  q('UPDATE fits SET updated_at=? WHERE id=?').run(now(), parent.fit_id);
  return { id, seq, filename, cost, resume_mode };
});

// settings -----------------------------------------------------------------
route('POST', '/api/settings', (_, body) => {
  for (const [k, v] of Object.entries(body)) q('INSERT OR REPLACE INTO settings VALUES (?,?)').run(k, String(v));
  return getSettings();
});
route('POST', '/api/clear', (_, body) => {
  if (body.confirm !== 'CLEAR') throw httpErr(400, 'send {confirm:"CLEAR"}');
  for (const f of readdirSync(LIB)) rm(LIB, f);
  for (const f of readdirSync(GEN)) rm(GEN, f);
  db.exec('DELETE FROM image_refs; DELETE FROM images; DELETE FROM fit_shortlist; DELETE FROM fits; DELETE FROM item_photos; DELETE FROM items; DELETE FROM me_photos; DELETE FROM settings;');
  return { ok: true };
});

// export / import — a gzipped tar (no zip container in node's stdlib) ------------
function tar(entries) {                                // entries: [{name, data:Buffer}]
  const blocks = [];
  for (const { name, data } of entries) {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
function untar(buf) {
  const out = []; let o = 0;
  while (o + 512 <= buf.length) {
    const name = buf.toString('utf8', o, o + 100).replace(/\0.*$/s, ''); if (!name) break;
    const size = parseInt(buf.toString('utf8', o + 124, o + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    out.push({ name, data: buf.subarray(o + 512, o + 512 + size) });
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
route('GET', '/api/export', () => {
  const entries = [{ name: 'fitroom.json', data: Buffer.from(JSON.stringify({ version: 1, exported_at: now(), ...dumpTables() })) }];
  for (const f of readdirSync(LIB)) entries.push({ name: `library/${f}`, data: readFileSync(join(LIB, f)) });
  for (const f of readdirSync(GEN)) entries.push({ name: `generated/${f}`, data: readFileSync(join(GEN, f)) });
  return { __raw: gzipSync(tar(entries)), type: 'application/gzip', name: `fitroom-${now().slice(0, 10)}.tar.gz` };
});
function dumpTables() {
  const t = {};
  for (const name of ['items', 'item_photos', 'me_photos', 'fits', 'fit_shortlist', 'images', 'image_refs', 'settings']) t[name] = q(`SELECT * FROM ${name}`).all();
  return t;
}
route('POST', '/api/import', (_, body) => {                // body.data = data:application/gzip;base64,...
  const m = /^data:[^;]+;base64,(.+)$/s.exec(body.data || ''); if (!m) throw httpErr(400, 'expected a data: URL');
  const entries = untar(gunzipSync(Buffer.from(m[1], 'base64')));
  const meta = entries.find(e => e.name === 'fitroom.json'); if (!meta) throw httpErr(400, 'archive has no fitroom.json');
  const t = JSON.parse(meta.data.toString('utf8'));
  db.exec('BEGIN');
  try {
    if (body.replace) db.exec('DELETE FROM image_refs; DELETE FROM images; DELETE FROM fit_shortlist; DELETE FROM fits; DELETE FROM item_photos; DELETE FROM items; DELETE FROM me_photos; DELETE FROM settings;');
    const ins = (table, rows) => { for (const r of rows || []) { const k = Object.keys(r); q(`INSERT OR REPLACE INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => r[x])); } };
    ins('items', t.items); ins('item_photos', t.item_photos); ins('me_photos', t.me_photos); ins('fits', t.fits);
    ins('fit_shortlist', t.fit_shortlist); ins('images', t.images); ins('image_refs', t.image_refs); ins('settings', t.settings);
    for (const e of entries) {
      if (e.name.startsWith('library/')) writeFileSync(join(LIB, basename(e.name)), e.data);
      else if (e.name.startsWith('generated/')) writeFileSync(join(GEN, basename(e.name)), e.data);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true, items: (t.items || []).length, fits: (t.fits || []).length, images: (t.images || []).length };
});

// ---------------------------------------------------------------- http
function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((res, rej) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { rej(httpErr(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks))); req.on('error', rej);
  });
}
function serveStatic(res, dir, name) {
  const file = join(dir, basename(name));
  if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  const st = statSync(file);
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(res, ROOT, 'index.html');
    if (url.pathname.startsWith('/library/')) return serveStatic(res, LIB, url.pathname.slice(9));
    if (url.pathname.startsWith('/generated/')) return serveStatic(res, GEN, url.pathname.slice(11));
    for (const r of routes) {
      const m = r.method === req.method && r.re.exec(url.pathname);
      if (!m) continue;
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString('utf8') || '{}') : {};
      const out = await r.fn(m.groups || {}, body, url);
      if (out?.__raw) {
        res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.name}"`, 'Content-Length': out.__raw.length });
        return res.end(out.__raw);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
  }
});
server.listen(PORT, () => console.log(`fitroom  http://localhost:${PORT}   key: ${KEY ? 'loaded from .env' : 'MISSING'}   db: fitroom.db`));
