// "Contact admin": a message or a voice note from an owner or manager to the administrator's Telegram.
// Shared by Restaurant Pal, Travel Pal and the Pal Monitor (copy this file; keep the copies the same).
//
//   import { contactAdmin } from "./contact-admin.js";
//   contactAdmin({ app: "Restaurant Pal", screen: "Stock", send: async payload => { ... } });
//
// payload = { screen, text, voice: { b64, mime, seconds } | null }. The app's send() delivers it
// (each app has its own checked route to AVA). Voice notes are recorded in the browser; Chrome's WebM
// recording is repackaged as Ogg so Telegram shows it as a voice message. Nothing else leaves the phone.

const MAX_SECONDS = 60;
let open = false;

// ---------------------------------------------------------------- WebM (Opus) -> Ogg (Opus), no re-encoding
function webmToOgg(buf) {
  const d = new Uint8Array(buf); let p = 0;
  const vint = (keepMarker) => { const b = d[p]; let len = 1, mask = 0x80; while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
    let v = keepMarker ? b : b & (mask - 1); for (let i = 1; i < len; i++) v = v * 256 + d[p + i]; const unknown = !keepMarker && (b & (mask - 1)) === mask - 1 && len === 1 ? true : false; p += len; return { v, len, unknown: unknown || (!keepMarker && v === Math.pow(2, 7 * len) - 1) }; };
  const MASTER = new Set([0x18538067, 0x1F43B675, 0x1654AE6B, 0xAE, 0xA0]);
  let head = null; const packets = [];
  while (p < d.length - 2) {
    const id = vint(true).v, sz = vint(false);
    if (MASTER.has(id)) continue;                       // step inside containers
    if (sz.unknown) return null;
    const end = p + sz.v;
    if (id === 0x63A2) head = d.slice(p, end);           // CodecPrivate = OpusHead
    else if (id === 0xA3 || id === 0xA1) {               // SimpleBlock / Block: track, timecode(2), flags(1), frame
      const s = p; vint(false); const flags = d[p + 2]; p += 3;
      if ((flags & 0x06) === 0) packets.push(d.slice(p, end)); p = s;
    }
    p = end;
  }
  if (!packets.length) return null;
  if (!head || String.fromCharCode(...head.slice(0, 8)) !== "OpusHead")
    head = new Uint8Array([79, 112, 117, 115, 72, 101, 97, 100, 1, 1, 56, 1, 128, 187, 0, 0, 0, 0, 0]);
  const tags = new TextEncoder().encode("OpusTags"), vendor = new TextEncoder().encode("Pal");
  const tagPkt = new Uint8Array(8 + 4 + vendor.length + 4); tagPkt.set(tags); new DataView(tagPkt.buffer).setUint32(8, vendor.length, true); tagPkt.set(vendor, 12);
  const samples = pk => { const toc = pk[0], cfg = toc >> 3, c = toc & 3;
    const ms = cfg < 12 ? [10, 20, 40, 60][cfg % 4] : cfg < 16 ? [10, 20][cfg % 2] : [2.5, 5, 10, 20][cfg % 4];
    const n = c === 0 ? 1 : c < 3 ? 2 : (pk[1] & 0x3F); return n * ms * 48; };
  // Ogg CRC (polynomial 0x04C11DB7, not reflected)
  const T = new Uint32Array(256); for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04C11DB7 : r << 1; T[i] = r >>> 0; }
  const crc = b => { let c = 0; for (let i = 0; i < b.length; i++) c = ((c << 8) ^ T[((c >>> 24) ^ b[i]) & 0xFF]) >>> 0; return c; };
  const serial = (Math.random() * 0xFFFFFFFF) >>> 0; let seq = 0; const pages = [];
  const page = (pkts, granule, type) => {
    const lace = []; for (const k of pkts) { let n = k.length; while (n >= 255) { lace.push(255); n -= 255; } lace.push(n); }
    const body = pkts.reduce((a, k) => a + k.length, 0), out = new Uint8Array(27 + lace.length + body), v = new DataView(out.buffer);
    out.set([79, 103, 103, 83, 0, type]); v.setUint32(6, granule % 4294967296, true); v.setUint32(10, Math.floor(granule / 4294967296), true);
    v.setUint32(14, serial, true); v.setUint32(18, seq++, true); out[26] = lace.length; out.set(lace, 27);
    let o = 27 + lace.length; for (const k of pkts) { out.set(k, o); o += k.length; }
    v.setUint32(22, crc(out), true); pages.push(out); };
  page([head], 0, 2); page([tagPkt], 0, 0);
  const pre = head[10] | (head[11] << 8); let g = pre, batch = [];
  packets.forEach((k, i) => { batch.push(k); g += samples(k);
    const last = i === packets.length - 1; if (batch.length >= 40 || last) { page(batch, g, last ? 4 : 0); batch = []; } });
  return new Blob(pages, { type: "audio/ogg" });
}

const b64 = blob => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = no; r.readAsDataURL(blob); });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- the panel
export function contactAdmin({ app, screen, send, prefill = "" }) {
  if (open) return; open = true;
  const wrap = document.createElement("div");
  wrap.className = "ca-wrap"; wrap.setAttribute("role", "dialog"); wrap.setAttribute("aria-label", "Contact admin");
  wrap.innerHTML = `<style>
.ca-wrap{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center;padding:12px;font-family:inherit}
.ca-box{width:min(460px,100%);background:#15151c;color:#f4f4f6;border:1px solid #33333d;border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 10px 40px #000a}
.ca-box h3{margin:0;font-size:18px}.ca-box p{margin:0;color:#a3a3ad;font-size:13px}
.ca-box textarea{width:100%;min-height:90px;resize:vertical;border-radius:10px;border:1px solid #33333d;background:#0b0b10;color:#f4f4f6;padding:10px;font:inherit;font-size:15px;box-sizing:border-box}
.ca-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ca-btn{font:inherit;font-weight:800;font-size:14px;padding:10px 14px;border-radius:10px;border:1px solid #33333d;background:#22222c;color:#f4f4f6;cursor:pointer;touch-action:none;user-select:none}
.ca-btn.go{background:#FFE000;color:#111;border-color:#FFE000}.ca-btn.rec{background:#b3261e;border-color:#b3261e;color:#fff}
.ca-btn:disabled{opacity:.5}.ca-note{font-size:13px;color:#cfd3ef}.ca-note audio{height:32px;vertical-align:middle;max-width:220px}
</style><div class="ca-box">
<h3>Contact admin</h3><p>${esc(app)} · this goes straight to the administrator on Telegram.</p>
<textarea class="ca-text" placeholder="Type a message (optional if you send a voice note)" maxlength="1000">${esc(prefill)}</textarea>
<div class="ca-row"><button class="ca-btn ca-mic" type="button">Hold to record</button><span class="ca-note"></span></div>
<div class="ca-row" style="justify-content:flex-end"><button class="ca-btn ca-x" type="button">Cancel</button><button class="ca-btn go ca-send" type="button">Send</button></div>
<p class="ca-msg" role="status"></p></div>`;
  document.body.appendChild(wrap);
  const $ = s => wrap.querySelector(s), note = $(".ca-note"), mic = $(".ca-mic"), msg = $(".ca-msg");
  let rec = null, chunks = [], voice = null, t0 = 0, timer = null, stream = null;
  const close = () => { try { rec && rec.state !== "inactive" && rec.stop(); } catch { } stream && stream.getTracks().forEach(t => t.stop()); clearInterval(timer); wrap.remove(); open = false; };
  const canRec = !!(navigator.mediaDevices && window.MediaRecorder);
  if (!canRec) { mic.disabled = true; note.textContent = "Voice notes aren't available in this browser."; }
  const start = async e => {
    e.preventDefault(); if (!canRec || (rec && rec.state === "recording")) return;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { note.textContent = "Allow the microphone to record a voice note."; return; }
    const type = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"].find(t => MediaRecorder.isTypeSupported(t)) || "";
    chunks = []; voice = null; rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    rec.ondataavailable = ev => ev.data.size && chunks.push(ev.data);
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); clearInterval(timer);
      const secs = Math.round((Date.now() - t0) / 1000); if (secs < 1) { note.textContent = "Too short. Hold the button while you talk."; mic.classList.remove("rec"); mic.textContent = "Hold to record"; return; }
      let blob = new Blob(chunks, { type: rec.mimeType || type }); let mime = blob.type.split(";")[0];
      if (mime === "audio/webm") { try { const ogg = webmToOgg(await blob.arrayBuffer()); if (ogg) { blob = ogg; mime = "audio/ogg"; } } catch { } }
      voice = { blob, mime, seconds: secs };
      note.innerHTML = `Voice note · ${secs}s <audio controls src="${URL.createObjectURL(blob)}"></audio> <button class="ca-btn ca-del" type="button" style="padding:6px 10px">✕</button>`;
      $(".ca-del").onclick = () => { voice = null; note.textContent = ""; };
      mic.classList.remove("rec"); mic.textContent = "Record again";
    };
    rec.start(); t0 = Date.now(); mic.classList.add("rec"); mic.textContent = "● Recording… let go to stop";
    timer = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); note.textContent = `${s}s`; if (s >= MAX_SECONDS) stop(); }, 250);
  };
  const stop = e => { e && e.preventDefault(); if (rec && rec.state === "recording") rec.stop(); };
  mic.addEventListener("pointerdown", start); mic.addEventListener("pointerup", stop); mic.addEventListener("pointerleave", stop); mic.addEventListener("pointercancel", stop);
  $(".ca-x").onclick = close; wrap.addEventListener("click", e => { if (e.target === wrap) close(); });
  $(".ca-send").onclick = async () => {
    const text = $(".ca-text").value.trim();
    if (!text && !voice) { msg.textContent = "Type a message or record a voice note first."; return; }
    const btn = $(".ca-send"); btn.disabled = true; msg.textContent = "Sending…";
    try {
      const v = voice ? { b64: await b64(voice.blob), mime: voice.mime, seconds: voice.seconds } : null;
      const r = await send({ screen, text, voice: v });
      if (!r || r.ok === false) throw new Error((r && r.error) || "It didn't go through.");
      msg.textContent = "✓ Sent to the administrator."; setTimeout(close, 1400);
    } catch (e) { msg.textContent = (e && e.message) || "It didn't go through. Try again."; btn.disabled = false; }
  };
  setTimeout(() => $(".ca-text").focus(), 50);
}

export { webmToOgg };
