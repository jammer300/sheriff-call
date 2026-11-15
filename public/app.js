(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const app = $("app");
const params = new URLSearchParams(location.search);
const DEBUG = params.has("debug");
if (DEBUG && params.get("debug") !== "quiet") app.classList.add("debug");
const BARGE_RMS = parseFloat(params.get("barge") || "0.06");
const MAX_CALL_MS = 20 * 60 * 1000;
const RATE = 24000;

const CHARS = {
  sheriff: { name: "Шериф", dat: "Шерифу", he: "он", waits: "будет ждать" },
  papillon: { name: "Папийон", dat: "Папийон", he: "она", waits: "будет ждать" },
  dobie: { name: "Доби", dat: "Доби", he: "он", waits: "будет ждать" },
};
let charId = CHARS[params.get("c")] ? params.get("c") : "sheriff", LAYOUT = null;
fetch("c/layout.json").then((r) => r.json()).then((j) => { LAYOUT = j; applyChar(charId); }).catch(() => {});
function applyChar(c) {
  if (typeof renderFriendsBar === "function") setTimeout(renderFriendsBar, 0);
  charId = c; const ch = CHARS[c];
  $("baseImg").src = `c/${c}/base.png`; $("mouth").src = `c/${c}/mouth.png`; $("blink").src = `c/${c}/blink.png`;
  $("ringImg").src = `c/${c}/avatar.jpg`;
  $("topName").textContent = ch.name; $("listenName").textContent = ch.name;
  if (LAYOUT && LAYOUT[c]) ["mouth", "blink"].forEach((k) => {
    const [x, y, w, h] = LAYOUT[c][k], el = $(k);
    el.style.left = x + "%"; el.style.top = y + "%"; el.style.width = w + "%"; el.style.height = h + "%";
  });
  S.char = c;
}
const S = window.__sheriff = {
  state: "idle", events: [], audioChunks: 0, audioSamples: 0, transcripts: [], userTranscripts: [], errors: [],
  sessionCreated: false, sessionUpdated: false, speechStarted: 0, fnCalls: [], looks: [], notes: [], room: "office",
};
function log(...a) {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  if (DEBUG) { const d = $("debug"); d.textContent += line + "\n"; d.scrollTop = 1e9; }
  console.log("[sheriff]", line);
}
function setState(s) {
  S.state = s;
  app.classList.remove("state-idle", "state-ringing", "state-incall", "state-ended");
  app.classList.add("state-" + s);
}

let ctx, micStream, camStream, ws, workletNode, micSource, outGain, analyser;
let nextPlay = 0, sources = [], curItem = null, curItemStart = 0;
let callStart = 0, timerInt, ringTimer, wakeLock, muted = false;
let hangingUp = false, reconnects = 0, firstUpdate = true, goodbyeSent = false;

/* ---------------- ringing tone ---------------- */
function ringOnce() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const g = ctx.createGain(); g.connect(ctx.destination);
  g.gain.setValueAtTime(0, t);
  [[0, 0.35], [0.45, 0.8]].forEach(([a, b]) => {
    g.gain.linearRampToValueAtTime(0.18, t + a + 0.02);
    g.gain.setValueAtTime(0.18, t + b - 0.03);
    g.gain.linearRampToValueAtTime(0, t + b);
  });
  [659.25, 783.99].forEach((f, i) => {
    const o = ctx.createOscillator(); o.type = "sine";
    o.frequency.setValueAtTime(f, t); o.frequency.setValueAtTime(f * 1.25, t + 0.45);
    const og = ctx.createGain(); og.gain.value = i ? 0.6 : 1;
    o.connect(og); og.connect(g); o.start(t); o.stop(t + 0.85);
  });
}
function startRinging() { ringOnce(); ringTimer = setInterval(ringOnce, 1900); }
function stopRinging() { clearInterval(ringTimer); ringTimer = null; }
function blip(f1, f2) {
  if (!ctx) return; const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(f1, t); o.frequency.exponentialRampToValueAtTime(f2, t + 0.25);
  g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.32);
}

/* ---------------- audio out ---------------- */
function playPcm16(b64, dest) {
  const bin = atob(b64); const n = bin.length >> 1;
  if (!n) return;
  const buf = ctx.createBuffer(1, n, RATE); const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; ch[i] = v / 32768; }
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest || outGain);
  const now = ctx.currentTime;
  if (nextPlay < now + 0.05) nextPlay = now + 0.08;
  src.start(nextPlay); nextPlay += buf.duration;
  sources.push(src); src.onended = () => { sources = sources.filter((s) => s !== src); };
  S.audioChunks++; S.audioSamples += n;
}
function stopPlayback() {
  sources.forEach((s) => { try { s.stop(); } catch (e) {} });
  sources = []; nextPlay = 0;
}
function isSpeaking() { return ctx && nextPlay > ctx.currentTime; }

/* ---------------- audio in ---------------- */
// Mic is sent at the AudioContext's native rate when the API supports it (no resampling);
// otherwise low-pass + resample to 24 kHz.
const API_RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000];
const NS = params.get("ns") === "1";            // noise suppression off by default (it eats child voices)
const AGC = params.get("agc") !== "0";          // auto gain on by default
const CHUNK_MS = 40;
const PREROLL_MS = parseInt(params.get("preroll") || "400", 10);
const HANG_MS = parseInt(params.get("hang") || "900", 10);
let inRate = RATE, micBuf = [], micBufLen = 0, preroll = [], prerollLen = 0, gateOpenUntil = 0, lpPrev = 0, rsPos = 0, rsLast = 0;
const workletCode = `class Cap extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('cap',Cap);`;
async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: NS, autoGainControl: AGC, channelCount: 1 } });
  const url = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
  await ctx.audioWorklet.addModule(url);
  micSource = ctx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(ctx, "cap");
  workletNode.port.onmessage = (e) => onMicFrame(e.data);
  const sink = ctx.createGain(); sink.gain.value = 0;
  micSource.connect(workletNode); workletNode.connect(sink); sink.connect(ctx.destination);
  inRate = API_RATES.includes(ctx.sampleRate) ? ctx.sampleRate : RATE;
  S.micRate = inRate; S.ctxRate = ctx.sampleRate; S.ns = NS; S.agc = AGC;
  log("mic", { ctxRate: ctx.sampleRate, sendRate: inRate, ns: NS, agc: AGC });
}
function resampleTo24k(f32) {
  // fallback only (ctx rate not accepted by the API): 1-pole low-pass then linear interpolation
  const ratio = ctx.sampleRate / RATE, a = Math.min(1, (2 * Math.PI * 10000) / ctx.sampleRate);
  const x = new Float32Array(f32.length);
  for (let i = 0; i < f32.length; i++) { lpPrev += a * (f32[i] - lpPrev); x[i] = lpPrev; }
  const out = [];
  while (rsPos < x.length) {
    const i = Math.floor(rsPos), fr = rsPos - i;
    const s0 = i === 0 ? rsLast : x[i - 1], s1 = x[i];   // rsPos is offset by +1 sample (rsLast = previous chunk tail)
    out.push(s0 + (s1 - s0) * fr); rsPos += ratio;
  }
  rsPos -= x.length; rsLast = x[x.length - 1];
  return Float32Array.from(out);
}
function onMicFrame(f32) {
  const x = inRate === ctx.sampleRate ? f32 : resampleTo24k(f32);
  micBuf.push(x); micBufLen += x.length;
  if (micBufLen >= inRate * CHUNK_MS / 1000) flushMic();
}
function toB64Pcm(f32) {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) { const v = Math.max(-1, Math.min(1, f32[i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
  const u8 = new Uint8Array(pcm.buffer); let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}
function sendAudio(f32) {
  if (ws && ws.readyState === 1 && S.sessionUpdated) ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toB64Pcm(f32) }));
}
function flushMic() {
  const all = new Float32Array(micBufLen); let o = 0;
  micBuf.forEach((p) => { all.set(p, o); o += p.length; });
  micBuf = []; micBufLen = 0;
  let sum = 0; for (let i = 0; i < all.length; i++) sum += all[i] * all[i];
  const rms = Math.sqrt(sum / all.length); S.micRms = rms;
  const nowMs = performance.now();
  if (muted) { preroll = []; prerollLen = 0; sendAudio(new Float32Array(all.length)); S.gate = "muted"; return; }
  // Echo gate ONLY while Sheriff's audio is actually playing (plus 150 ms tail).
  const sheriffTalking = ctx.currentTime < nextPlay + 0.15;
  if (!sheriffTalking) {
    if (prerollLen) { preroll.forEach(sendAudio); preroll = []; prerollLen = 0; }
    sendAudio(all); S.gate = "open"; return;
  }
  // While he talks: open fast on loud speech (barge-in), close slowly (hangover), with pre-roll so onsets aren't lost.
  if (rms > BARGE_RMS) gateOpenUntil = nowMs + HANG_MS;
  if (nowMs < gateOpenUntil) {
    if (prerollLen) { preroll.forEach(sendAudio); preroll = []; prerollLen = 0; }
    sendAudio(all); S.gate = "barge"; return;
  }
  preroll.push(all); prerollLen += all.length;
  while (prerollLen - preroll[0].length >= inRate * PREROLL_MS / 1000) prerollLen -= preroll.shift().length;
  sendAudio(new Float32Array(all.length)); S.gate = "echo-guard";
}

/* ---------------- realtime session ---------------- */
async function connect(isReconnect) {
  // The server proxies the realtime session; persona/private context stay server-side.
  const q = new URLSearchParams();
  ["voice", "vad", "silence", "prefix", "name"].forEach((k) => { if (params.get(k)) q.set(k, params.get(k)); });
  q.set("c", charId);
  q.set("rate", String(inRate));
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + location.pathname.replace(/[^/]*$/, "") + "rt?" + q;
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; try { sock.close(); } catch (e) {} reject(new Error("timeout")); } }, 8000);
    sock.onmessage = (m) => {
      if (typeof m.data !== "string") return;
      const e = JSON.parse(m.data);
      if (e.type === "session.created" && !done) {
        done = true; clearTimeout(to); S.sessionCreated = true;
        ws = sock; firstUpdate = true; attach(sock, isReconnect); resolve();
      }
    };
    sock.onerror = () => { if (!done) { done = true; clearTimeout(to); reject(new Error("ws error")); } };
    sock.onclose = (ev) => { if (!done) { done = true; clearTimeout(to); reject(new Error("closed " + ev.code)); } };
  });
}
async function connectWithRetry(isReconnect) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { await connect(isReconnect); return; } catch (e) { last = e; log("connect fail", String(e)); if (hangingUp) return; }
  }
  throw last;
}
let respActive = false;
function sayAsUser(text) {
  if (!ws) return;
  ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
  ws.send(JSON.stringify({ type: "response.create" }));
}
let captionText = "";
function attach(sock, isReconnect) {
  sock.onmessage = (m) => {
    if (typeof m.data !== "string") return;
    const e = JSON.parse(m.data);
    if (e.type !== "response.output_audio.delta" && e.type !== "response.output_audio_transcript.delta") { S.events.push(e.type); log("←", e.type, e.type === "error" ? e : ""); }
    switch (e.type) {
      case "session.updated":
        if (firstUpdate) S.turn = e.session && e.session.turn_detection;
        if (firstUpdate) {
          firstUpdate = false; S.sessionUpdated = true; respActive = false; pendingFn = 0; needContinue = false;
          if (S.state === "ringing") enterCall();
          sayAsUser(isReconnect
            ? "(Служебная заметка, не читай вслух: связь на секунду прервалась и восстановилась. Весело скажи, что связь вернулась, и продолжай болтать с девочкой.)"
            : "(Служебная заметка, не читай вслух: девочка только что позвонила тебе по видеосвязи. Радостно поздоровайся первым. Если ты уже знаешь её имя — назови её по имени и не спрашивай имя. Если не знаешь — коротко представься и спроси, как её зовут.)");
        }
        break;
      case "input_audio_buffer.speech_started":
        S.speechStarted++;
        app.classList.add("listening");
        if (isSpeaking()) {
          const playedMs = Math.max(0, Math.round((ctx.currentTime - curItemStart) * 1000));
          stopPlayback();
          if (curItem) sock.send(JSON.stringify({ type: "conversation.item.truncate", item_id: curItem, content_index: 0, audio_end_ms: playedMs }));
        }
        break;
      case "input_audio_buffer.speech_stopped": app.classList.remove("listening"); break;
      case "conversation.item.input_audio_transcription.completed": S.userTranscripts.push(e.transcript); log("child:", e.transcript); break;
      case "response.created": captionText = ""; respActive = true; break;
      case "response.done": respActive = false; onResponseDone(e); break;
      case "response.function_call_arguments.done": onFunctionCall(e); break;
      case "x.look.done": lookDone(e); break;
      case "x.look.result": S.looks.push(e); break;
      case "x.tts.audio": onTtsAudio(e); break;
      case "response.output_item.added": curItem = e.item && e.item.id; curItemStart = Math.max(ctx.currentTime, nextPlay); break;
      case "response.output_audio.delta": app.classList.remove("listening"); playPcm16(e.delta); break;
      case "response.output_audio_transcript.delta": captionText += e.delta || ""; showCaption(captionText); checkRunaway(captionText); break;
      case "response.output_audio_transcript.done": S.transcripts.push(e.transcript); log("sheriff:", e.transcript); break;
      case "error": S.errors.push(e); break;
    }
  };
  sock.onclose = (ev) => {
    log("ws closed", ev.code, ev.reason);
    if (ws === sock) ws = null;
    S.sessionUpdated = false;
    if (!hangingUp && S.state === "incall" && reconnects < 3) {
      reconnects++;
      connectWithRetry(true).catch((e) => { fail("Связь потерялась 😢 Попробуй позвонить ещё раз."); });
    }
  };
}
// If the voice model gets stuck repeating a word ("shy shy shy shy…"), cut it off and ask for one short sentence.
let runawayCut = 0;
function checkRunaway(t) {
  const w = t.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
  let run = 1, max = 1;
  for (let i = 1; i < w.length; i++) { run = w[i] === w[i - 1] ? run + 1 : 1; if (run > max) max = run; }
  const tail = w.slice(-12), uniq = new Set(tail).size;
  if (max >= 5 || (tail.length >= 12 && uniq <= 3) || t.length > 900) {
    if (Date.now() - runawayCut < 3000) return;
    runawayCut = Date.now(); S.runawayCuts = (S.runawayCuts || 0) + 1; log("runaway speech cut", t.slice(-80));
    captionText = ""; interrupt();
    noteQueue.push("(Служебная заметка, не читай вслух: твой последний ответ сломался и повторял одно слово — его обрезали. Скажи заново ОДНО короткое нормальное предложение, без повторов.)");
  }
}
let capTimer;
function showCaption(t) {
  const words = t.split(/\s+/); const tail = words.slice(-18).join(" ");
  $("caption").innerHTML = "<span></span>"; $("caption").firstChild.textContent = tail;
  clearTimeout(capTimer); capTimer = setTimeout(() => { $("caption").innerHTML = ""; }, 6000);
}

/* ---------------- call flow ---------------- */
async function startCall(c) {
  if (typeof c === "string" && CHARS[c]) applyChar(c);
  $("err").textContent = "";
  hangingUp = false; reconnects = 0; goodbyeSent = false;
  setRoom("office", true); hideBoard();
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  if (!outGain) {
    outGain = ctx.createGain(); outGain.gain.value = 1.0;
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    outGain.connect(analyser); outGain.connect(ctx.destination);
  }
  setState("ringing");
  $("lobbyTitle").textContent = "Звоним: " + CHARS[charId].name + "…";
  $("lobbySub").textContent = "Сейчас " + CHARS[charId].he + " возьмёт трубку 🐶";
  startRinging();
  const ringMin = new Promise((r) => setTimeout(r, 2600));
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("nomedia");
    await startMic();
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => { camStream = s; $("selfie").srcObject = s; }).catch((e) => log("no camera", String(e)));
    await ringMin;
    if (hangingUp) return;
    await connectWithRetry(false);
  } catch (e) {
    log("start error", String(e && e.message || e));
    if (hangingUp) return;
    if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) fail("Разреши, пожалуйста, микрофон — без него " + CHARS[charId].name + " тебя не услышит 🎤");
    else if (String(e.message) === "nomedia") fail("Этот браузер не даёт микрофон. Открой страницу в Safari или Chrome по https.");
    else fail(CHARS[charId].name + " пока не отвечает. Попробуй ещё раз! (" + (e.message || e) + ")");
  }
}
function enterCall() {
  stopRinging(); blip(500, 900);
  setState("incall"); callStart = Date.now();
  timerInt = setInterval(() => {
    const s = Math.floor((Date.now() - callStart) / 1000);
    $("timer").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    if (!goodbyeSent && Date.now() - callStart > MAX_CALL_MS - 30000 && ws) {
      goodbyeSent = true;
      sayAsUser("(Служебная заметка: звонок скоро закончится. Скажи, что тебе пора на дежурство, тепло попрощайся и пригласи звонить ещё.)");
    }
    if (Date.now() - callStart > MAX_CALL_MS && !isSpeaking()) hangUp();
  }, 500);
  if (navigator.wakeLock) navigator.wakeLock.request("screen").then((w) => (wakeLock = w)).catch(() => {});
}
function cleanup() {
  stopRinging(); clearInterval(timerInt); stopPlayback();
  try { ws && ws.close(); } catch (e) {} ws = null; S.sessionUpdated = false;
  try { workletNode && workletNode.disconnect(); micSource && micSource.disconnect(); } catch (e) {}
  [micStream, camStream].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  micStream = camStream = null; $("selfie").srcObject = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  app.classList.remove("listening");
  $("caption").innerHTML = ""; hideBoard(); clearGuests();
}
function hangUp() {
  hangingUp = true; cleanup(); blip(700, 300);
  setState("idle");
  $("lobbyTitle").textContent = "Пока-пока! 👋";
  $("lobbySub").textContent = CHARS[charId].name + " " + CHARS[charId].waits + " твоего звонка. Кому позвоним ещё?";
}
function fail(msg) {
  hangingUp = true; cleanup(); setState("idle");
  $("lobbyTitle").textContent = "Кому позвоним?";
  $("lobbySub").textContent = "Полицейский участок • все на связи 🚓";
  $("err").textContent = msg;
}
document.querySelectorAll(".pick").forEach((b) => b.addEventListener("click", () => startCall(b.dataset.c)));
$("hangBtn").addEventListener("click", hangUp);
$("cancelBtn").addEventListener("click", hangUp);
$("micBtn").addEventListener("click", () => { muted = !muted; $("micBtn").classList.toggle("off", muted); $("micBtn").textContent = muted ? "🔇" : "🎤"; });
$("ccBtn").addEventListener("click", () => app.classList.toggle("cc"));
if (params.has("cc")) app.classList.add("cc");

/* ---------------- notes from the app, tool calls, continuation ---------------- */
let noteQueue = [], pendingFn = 0, needContinue = false, kicking = false;
const waitPlayback = () => new Promise((res) => { const t0 = Date.now(); const iv = setInterval(() => { if (!isSpeaking() || Date.now() - t0 > 15000) { clearInterval(iv); res(); } }, 100); });
function interrupt() {
  if (!ws) return;
  if (respActive) ws.send(JSON.stringify({ type: "response.cancel" }));
  if (isSpeaking()) {
    const playedMs = Math.max(0, Math.round((ctx.currentTime - curItemStart) * 1000));
    stopPlayback();
    if (curItem) ws.send(JSON.stringify({ type: "conversation.item.truncate", item_id: curItem, content_index: 0, audio_end_ms: playedMs }));
  }
}
function note(text, opts = {}) {
  if (!ws || !S.sessionUpdated) return false;
  const busy = respActive || isSpeaking() || pendingFn > 0;
  if (busy && opts.skipIfBusy) return false;
  if (busy && opts.interrupt) interrupt();
  S.notes.push(text);
  noteQueue.push("(Служебная заметка, не читай вслух: " + text + ")");
  kick(); return true;
}
async function kick() {
  if (!ws || respActive || pendingFn > 0 || kicking) return;
  if (!needContinue && !noteQueue.length) return;
  kicking = true;
  if (!noteQueue.length) await waitPlayback();
  kicking = false;
  if (!ws || respActive || pendingFn > 0) return;
  const notes = noteQueue.splice(0); needContinue = false;
  if (notes.length) ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: notes.join("\n") }] } }));
  ws.send(JSON.stringify({ type: "response.create" })); respActive = true;
}
function onResponseDone() { kick(); }
function fnOutput(callId, out) {
  if (ws) ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(out) } }));
}
function onFunctionCall(e) {
  let a = {}; try { a = JSON.parse(e.arguments || "{}"); } catch (err) {}
  S.fnCalls.push({ name: e.name, args: a, t: Date.now() }); log("tool", e.name, a);
  needContinue = true;
  if (e.name === "look_at_camera") {
    if (lookBusy) { fnOutput(e.call_id, { ok: false, error: "Already looking — wait for the picture. Do not call look_at_camera again now." }); return; }
    pendingFn++; doLook(e.call_id); return;
  }
  if (e.name === "friend_says") { pendingFn++; friendSays(e.call_id, a.who, a.text); return; }
  let out;
  try { out = runTool(e.name, a); } catch (err) { out = { ok: false, error: String(err) }; }
  fnOutput(e.call_id, out);
}
const SHOWN = "It is on her screen now. Continue naturally; do not repeat what you already said.";
function runTool(name, a) {
  switch (name) {
    case "show_count": { const n = Math.max(1, Math.min(10, parseInt(a.count, 10) || 3)); boardCount(oneEmoji(a.emoji, "⭐"), n); return { ok: true, shown: n, note: SHOWN + " She can tap the objects to count them." }; }
    case "show_letter": boardLetter(String(a.letter || "А").trim().slice(0, 1).toUpperCase(), String(a.word || "").slice(0, 24), oneEmoji(a.emoji, "")); return { ok: true, note: SHOWN };
    case "show_picture": boardPicture(oneEmoji(a.emoji, "⭐"), String(a.ru || "").slice(0, 24), String(a.en || "").slice(0, 24)); return { ok: true, note: SHOWN };
    case "show_high_five": boardFive(); return { ok: true, note: "A big paw is on her screen. Ask her to tap it and wait; you will get a note when she does." };
    case "show_colors": { const cs = (Array.isArray(a.colors) ? a.colors : []).filter((c) => COLORS[c]).slice(0, 4); boardColors(cs.length >= 2 ? cs : ["красный", "синий", "жёлтый"]); return { ok: true, note: "Colored circles are on her screen. Ask her to tap one; you will get a note which one she tapped." }; }
    case "celebrate": celebrate(); return { ok: true, note: "Confetti is flying on her screen!" };
    case "clear_screen": hideBoard(); return { ok: true };
    case "invite_friend": { if (!CHARS[a.who] || a.who === charId) return { ok: false, error: "unknown friend" }; if (guests.length >= 2 && !guestOf(a.who)) return { ok: false, error: "max 2 friends" }; addGuest(a.who); return { ok: true, joined: a.who, note: "The friend is on her screen now. Let them greet her via friend_says." }; }
    case "friend_leaves": removeGuest(a.who); return { ok: true, left: a.who };
    case "go_to_room": { const r = ROOMS[a.room] ? a.room : "office"; setRoom(r); return { ok: true, now_in: r, note: "You walked together into the " + r + ". Say one fun sentence about what is here." }; }
  }
  return { ok: false, error: "unknown tool" };
}
function oneEmoji(s, d) {
  s = String(s || "").trim(); if (!s) return d;
  if (window.Intl && Intl.Segmenter) { const g = [...new Intl.Segmenter().segment(s)][0]; return g ? g.segment : d; }
  return Array.from(s).slice(0, 2).join("");
}

/* ---------------- group call: friends ---------------- */
let guests = [], ttsChain = Promise.resolve(), ttsWait = {}, ttsSeq = 0;
const guestOf = (c) => guests.find((g) => g.c === c);
function addGuest(c) {
  if (guestOf(c) || c === charId || !CHARS[c]) return guestOf(c);
  const slot = guests.some((g) => g.slot === "L") ? "R" : "L";
  const wrap = el("div", "guest " + slot); const walk = el("div", "gwalk"); const body = el("div", "gbody");
  const mk = (k, cls) => { const i = document.createElement("img"); i.src = `c/${c}/${k}.png`; i.className = cls; i.draggable = false; return i; };
  const base = mk("base", "base"), blink = mk("blink", "ov"), mouth = mk("mouth", "ov");
  if (LAYOUT && LAYOUT[c]) [["mouth", mouth], ["blink", blink]].forEach(([k, e]) => { const [x, y, w, h] = LAYOUT[c][k]; Object.assign(e.style, { left: x + "%", top: y + "%", width: w + "%", height: h + "%" }); });
  mouth.style.opacity = 0; blink.style.opacity = 0;
  body.append(base, blink, mouth); walk.appendChild(body); wrap.appendChild(walk);
  const tag = el("div", "gname", CHARS[c].name); wrap.appendChild(tag);
  $("guests").appendChild(wrap);
  const gain = ctx.createGain(), an = ctx.createAnalyser(); an.fftSize = 1024; gain.connect(an); gain.connect(ctx.destination);
  const g = { c, slot, wrap, body, mouth, blink, gain, an, level: 0, open: false, nextBlink: performance.now() + 1500 + Math.random() * 2000, blinkUntil: 0 };
  guests.push(g); app.classList.add("group"); sfx("fanfare");
  requestAnimationFrame(() => wrap.classList.add("in"));
  S.guests = guests.map((x) => x.c); renderFriendsBar();
  return g;
}
function removeGuest(c) {
  const g = guestOf(c); if (!g) return;
  guests = guests.filter((x) => x !== g); g.wrap.classList.remove("in"); sfx("whoosh");
  setTimeout(() => { g.wrap.remove(); try { g.gain.disconnect(); } catch (e) {} }, 600);
  if (!guests.length) app.classList.remove("group");
  S.guests = guests.map((x) => x.c); renderFriendsBar();
}
function clearGuests() { guests.slice().forEach((g) => removeGuest(g.c)); guests = []; app.classList.remove("group"); }
function friendSays(callId, who, text) {
  const g = addGuest(who);
  if (!g || !text) { pendingFn = Math.max(0, pendingFn - 1); fnOutput(callId, { ok: false, error: "friend is not in the call" }); kick(); return; }
  const id = ++ttsSeq;
  // keep friends' lines in order even if TTS answers arrive out of order
  ttsChain = ttsChain.then(() => new Promise((res) => {
    ttsWait[id] = (e) => {
      if (e.audio && guestOf(who)) { playPcm16(e.audio, guestOf(who).gain); showCaption(CHARS[who].name + ": " + (e.text || text)); S.friendLines = (S.friendLines || []).concat({ who, text, ms: e.ms }); }
      fnOutput(callId, e.audio ? { ok: true, said: text, note: "Your friend said it in their own voice. Do not repeat it." } : { ok: false, error: "voice failed" });
      pendingFn = Math.max(0, pendingFn - 1); kick(); res();
    };
    if (!ws) return ttsWait[id]({});
    ws.send(JSON.stringify({ type: "x.tts", id, who, text }));
    setTimeout(() => ttsWait[id] && ttsWait[id]({}), 12000);
  }).then(() => { delete ttsWait[id]; }));
}
function onTtsAudio(e) { const f = ttsWait[e.id]; if (f) { ttsWait[e.id] = null; f(e); } }
function renderFriendsBar() {
  const bar = $("friends"); if (!bar) return; bar.innerHTML = "";
  Object.keys(CHARS).filter((c) => c !== charId).forEach((c) => {
    const b = document.createElement("button"); b.dataset.c = c; b.title = (guestOf(c) ? "Попрощаться: " : "Позвать: ") + CHARS[c].name;
    const im = document.createElement("img"); im.src = `c/${c}/avatar.jpg`; b.appendChild(im); b.appendChild(el("i", null, guestOf(c) ? "✕" : "+"));
    b.classList.toggle("cur", !!guestOf(c));
    b.addEventListener("click", () => {
      if (!ws || !S.sessionUpdated) return;
      if (guestOf(c)) { note(`девочка нажала кнопку — ${CHARS[c].name} прощается и уходит. Пусть ${CHARS[c].name} коротко попрощается через friend_says, потом вызови friend_leaves.`, { interrupt: true }); return; }
      if (guests.length >= 2) return;
      addGuest(c);
      note(`девочка нажала кнопку «Позвать» — ${CHARS[c].name} присоединился к звонку и уже на экране (invite_friend вызывать не нужно). Пусть ${CHARS[c].name} радостно поздоровается с ней через friend_says, а потом ты что-нибудь весело скажи.`, { interrupt: true });
    });
    bar.appendChild(b);
  });
}
renderFriendsBar();

/* ---------------- camera look ---------------- */
let lookBusy = false, lookTimer = null, lookCallId = null;
const LOOK_PX = parseInt(params.get("lookpx") || "1024", 10);
// sharpness = variance of a simple Laplacian on a small grayscale copy
function sharpness(c) {
  const w = 160, h = Math.round(c.height * 160 / c.width), t = document.createElement("canvas"); t.width = w; t.height = h;
  const x = t.getContext("2d"); x.drawImage(c, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) g[i] = d[4 * i] * 0.3 + d[4 * i + 1] * 0.59 + d[4 * i + 2] * 0.11;
  let sum = 0, sq = 0, n = 0, bright = 0;
  for (let y = 1; y < h - 1; y++) for (let i = 1; i < w - 1; i++) { const k = y * w + i; const L = 4 * g[k] - g[k - 1] - g[k + 1] - g[k - w] - g[k + w]; sum += L; sq += L * L; n++; bright += g[k]; }
  return { sharp: sq / n - (sum / n) ** 2, bright: bright / n };
}
function grabCanvas() {
  const v = $("selfie");
  if (!camStream || !v.videoWidth) return null;
  const sc = Math.min(1, LOOK_PX / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement("canvas"); c.width = Math.round(v.videoWidth * sc); c.height = Math.round(v.videoHeight * sc);
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);   // true (non-mirrored) orientation
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function countdown() {
  const pip = $("pip"); const o = el("div", "count3"); pip.appendChild(o);
  for (const n of ["3", "2", "1"]) { o.textContent = n; o.classList.remove("go"); void o.offsetWidth; o.classList.add("go"); sfx("pop", 3 - +n); await sleep(550); }
  o.textContent = "📸"; setTimeout(() => o.remove(), 500);
}
async function doLook(callId) {
  lookBusy = true; lookCallId = callId; $("lookBtn").classList.add("busy");
  // safety net: never leave the voice model waiting for this function result
  clearTimeout(lookTimer);
  lookTimer = setTimeout(() => {
    if (!lookBusy) return; log("look timeout");
    if (callId) fnOutput(callId, { ok: false, error: "Could not see the picture. Say «Не разглядел(а), покажи ещё раз поближе!»" });
    lookDone({ call_id: callId, timeout: true });
  }, 16000);
  let img = null;
  if (camStream && $("selfie").videoWidth) {
    app.classList.add("looking"); await countdown();
    // take 3 frames ~150 ms apart and keep the sharpest one (hands move!)
    let best = null;
    for (let i = 0; i < 3; i++) { const c = grabCanvas(); if (c) { const q = sharpness(c); if (!best || q.sharp > best.q.sharp) best = { c, q }; } if (i < 2) await sleep(150); }
    app.classList.remove("looking");
    if (best) {
      img = best.c.toDataURL("image/jpeg", 0.86).split(",")[1];
      S.lastLookFrame = { w: best.c.width, h: best.c.height, kb: Math.round(img.length * 0.75 / 1024), sharp: Math.round(best.q.sharp), bright: Math.round(best.q.bright) };
      log("look frame", S.lastLookFrame);
      const f = document.createElement("div"); f.className = "flash"; $("pip").appendChild(f); setTimeout(() => f.remove(), 400); sfx("shutter");
    }
  }
  if (!lookBusy) return;               // timed out meanwhile
  S.lookSentAt = performance.now();
  if (ws) ws.send(JSON.stringify({ type: "x.look", call_id: callId, image: img || undefined }));
  else lookDone({ call_id: callId });
}
function lookDone(e) {
  if (!lookBusy && !e.timeout) return;
  clearTimeout(lookTimer); lookBusy = false; $("lookBtn").classList.remove("busy");
  S.lookRoundTripMs = Math.round(performance.now() - (S.lookSentAt || 0));
  if (e.call_id) pendingFn = Math.max(0, pendingFn - 1);
  needContinue = true; kick();
}
$("lookBtn").addEventListener("click", () => {
  if (!ws || !S.sessionUpdated || lookBusy) return;
  if (respActive || isSpeaking()) interrupt();
  doLook(null);
});

/* ---------------- board (game visuals) ---------------- */
const COLORS = { "красный": "#ef4444", "оранжевый": "#f97316", "жёлтый": "#facc15", "зелёный": "#22c55e", "голубой": "#38bdf8", "синий": "#2563eb", "фиолетовый": "#8b5cf6", "розовый": "#f472b6", "белый": "#ffffff", "чёрный": "#1f2937", "коричневый": "#92400e" };
const board = $("board");
function el(tag, cls, text) { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
function showBoard(...kids) { board.innerHTML = ""; kids.forEach((k) => board.appendChild(k)); app.classList.remove("board-on"); void board.offsetWidth; app.classList.add("board-on"); S.board = board.textContent; sfx("pop"); }
function hideBoard() { app.classList.remove("board-on"); board.innerHTML = ""; S.board = ""; }
function boardCount(emoji, n) {
  const items = el("div", "items"); let counted = 0;
  for (let i = 0; i < n; i++) { const sp = el("span", null, emoji); sp.addEventListener("click", () => { if (sp.classList.contains("on")) return; sp.dataset.n = ++counted; sp.classList.add("on"); sfx("pop", counted); }); items.appendChild(sp); }
  showBoard(items, el("div", "q", "Сколько?"));
}
function boardLetter(L, word, emoji) {
  const w = el("div", "word"); if (word) { const f = el("span", null, word[0]); f.style.color = "#e11d48"; w.appendChild(f); w.appendChild(document.createTextNode(word.slice(1))); }
  showBoard(el("div", "letter", L + " " + L.toLowerCase()), el("div", "pic", emoji), w);
}
function boardPicture(emoji, ru, en) { showBoard(el("div", "pic", emoji), el("div", "word", ru), el("div", "en", en || "")); }
function boardFive() {
  const p = el("div", "paw", "🐾");
  p.addEventListener("click", () => {
    if (p.classList.contains("hit")) return;
    p.classList.add("hit"); sfx("clap"); celebrate(18);
    S.highFives = (S.highFives || 0) + 1;
    note("девочка дала тебе пять — хлопнула по твоей лапе на экране! Радостно отреагируй одной короткой фразой.", { interrupt: true });
    setTimeout(() => p.classList.remove("hit"), 700);
  });
  showBoard(p, el("div", "q", "Дай пять!"));
}
function boardColors(cs) {
  const d = el("div", "dots");
  cs.forEach((c) => { const b = el("div", "dot"); b.style.background = COLORS[c]; b.addEventListener("click", () => {
    d.querySelectorAll(".dot").forEach((x) => x.classList.remove("sel")); b.classList.add("sel"); sfx("pop");
    S.colorTaps = (S.colorTaps || []).concat(c);
    note(`девочка нажала на кружок цвета «${c}».`, { interrupt: true });
  }); d.appendChild(b); });
  showBoard(d);
}
function celebrate(n = 44) {
  const fx = $("fx"); const em = ["🎉", "⭐", "🌟", "💖", "🎈", "✨", "🐾"];
  for (let i = 0; i < n; i++) {
    const c = el("i", null, em[i % em.length]); c.style.left = Math.random() * 100 + "%";
    c.style.animationDuration = 1.6 + Math.random() * 1.6 + "s"; c.style.animationDelay = Math.random() * 0.5 + "s"; c.style.fontSize = 24 + Math.random() * 30 + "px";
    fx.appendChild(c); setTimeout(() => c.remove(), 4000);
  }
  sfx("fanfare"); S.celebrations = (S.celebrations || 0) + 1;
}

/* ---------------- sounds ---------------- */
function tone(f, t0, d, type = "sine", vol = 0.14, f2) {
  const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type;
  o.frequency.setValueAtTime(f, t0); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + d);
  g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + d);
  o.connect(g); g.connect(ctx.destination); o.start(t0); o.stop(t0 + d + 0.02);
}
function sfx(kind, k) {
  if (!ctx) return; const t = ctx.currentTime;
  if (kind === "pop") tone(500 + (k || 0) * 60, t, 0.12, "sine", 0.16, 900 + (k || 0) * 60);
  else if (kind === "fanfare") [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.11, 0.25, "triangle", 0.12));
  else if (kind === "boing") tone(180, t, 0.4, "sine", 0.2, 620);
  else if (kind === "giggle") [880, 990, 880, 1040, 920].forEach((f, i) => tone(f, t + i * 0.08, 0.07, "square", 0.04));
  else if (kind === "wiggle") [400, 520, 400, 520].forEach((f, i) => tone(f, t + i * 0.1, 0.09, "triangle", 0.1));
  else if (kind === "whoosh") tone(900, t, 0.5, "sawtooth", 0.03, 120);
  else if (kind === "shutter") { tone(1500, t, 0.05, "square", 0.05); tone(900, t + 0.06, 0.05, "square", 0.05); }
  else if (kind === "clap") {
    const b = ctx.createBuffer(1, ctx.sampleRate * 0.15, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.03));
    const s = ctx.createBufferSource(), g = ctx.createGain(); g.gain.value = 0.5; s.buffer = b; s.connect(g); g.connect(ctx.destination); s.start(t);
  }
}

/* ---------------- rooms ---------------- */
const ROOMS = { office: { name: "кабинет" }, garage: { name: "гараж" }, playroom: { name: "игровую" }, kitchen: { name: "кухню" } };
Object.keys(ROOMS).forEach((r) => { const i = new Image(); i.src = `rooms/${r}.jpg`; const j = new Image(); j.src = `rooms/${r}_fg.png`; });
let roomBusy = false;
function paintRoom(r) {
  $("bg").style.backgroundImage = `url(rooms/${r}.jpg)`; $("desk").src = `rooms/${r}_fg.png`;
  document.querySelectorAll("#rooms button").forEach((b) => b.classList.toggle("cur", b.dataset.r === r));
}
function setRoom(r, instant) {
  if (!ROOMS[r]) return;
  if (instant || S.state !== "incall") { S.room = r; paintRoom(r); return; }
  if (r === S.room || roomBusy) return;
  roomBusy = true; S.room = r; S.roomChanges = (S.roomChanges || 0) + 1; hideBoard();
  const w = $("walker"), d = $("desk");
  app.classList.add("walking"); sfx("whoosh");
  w.classList.add("out"); d.classList.add("out");
  setTimeout(() => {
    $("bg").classList.add("fade");
    setTimeout(() => {
      paintRoom(r); $("bg").classList.remove("fade");
      w.classList.remove("out"); d.classList.remove("out"); w.classList.add("in"); d.classList.add("in");
      void w.offsetWidth; w.classList.remove("in"); d.classList.remove("in");
      setTimeout(() => { app.classList.remove("walking"); roomBusy = false; }, 600);
    }, 250);
  }, 560);
}
document.querySelectorAll("#rooms button").forEach((b) => b.addEventListener("click", () => {
  const r = b.dataset.r; if (r === S.room || roomBusy) return;
  setRoom(r);
  note(`девочка нажала кнопку — вы вместе пришли в ${ROOMS[r].name}. Весело скажи об этом одной фразой и предложи, что тут можно поделать.`, { interrupt: true });
}));
const GAME_NOTES = {
  count: "девочка нажала кнопку игры «Счёт» 🔢. Начни игру: вызови show_count и спроси «Сколько?».",
  letters: "девочка нажала кнопку игры «Буквы» 🔤. Начни игру: вызови show_letter, назови букву и слово, попроси повторить.",
  words: "девочка нажала кнопку игры «Слова» 🐘. Начни игру: вызови show_picture и спроси «Что это?».",
  five: "девочка нажала кнопку «Дай пять!» ✋. Вызови show_high_five и попроси её хлопнуть по лапе на экране.",
  colors: "девочка нажала кнопку игры «Цвета» 🎨. Вызови show_colors и попроси нажать на один цвет.",
  story: "девочка нажала кнопку «Приключение» 📖. Начни большое полицейское приключение (или продолжи незаконченное из памяти), сделай её младшим офицером и спроси, что делать дальше.",
};
document.querySelectorAll("#games button").forEach((b) => b.addEventListener("click", () => {
  const g = b.dataset.g; let extra = "";
  if (g !== "story" && S.room !== "playroom") { setRoom("playroom"); extra = " Вы сейчас перешли в игровую."; }
  note(GAME_NOTES[g] + extra, { interrupt: true });
}));

/* ---------------- touch the character ---------------- */
let lastTap = 0, lastTapNote = 0;
$("tapZone").addEventListener("pointerdown", (ev) => {
  if (S.state !== "incall" || roomBusy) return;
  const now = Date.now(); if (now - lastTap < 700) return; lastTap = now;
  const r = $("sheriffWrap").getBoundingClientRect(); const y = (ev.clientY - r.top) / r.height;
  const zone = y < 0.3 ? "cap" : y < 0.58 ? "nose" : "belly";
  const fx = { cap: ["boing", "boing", "⭐"], nose: ["giggle", "giggle", "😆"], belly: ["wiggle", "wiggle", "💛"] }[zone];
  app.classList.remove("boing", "giggle", "wiggle"); void app.offsetWidth; app.classList.add(fx[0]);
  setTimeout(() => app.classList.remove(fx[0]), 1000);
  sfx(fx[1]);
  const s = el("div", "tapfx", fx[2]); s.style.left = ev.clientX + "px"; s.style.top = ev.clientY + "px"; document.body.appendChild(s); setTimeout(() => s.remove(), 1200);
  S.taps = (S.taps || []).concat(zone);
  if (now - lastTapNote > 4000) {
    const txt = { cap: "девочка нажала тебе на шапку (фуражку) на экране — ты подпрыгнул(а). Отреагируй одной короткой смешной фразой.",
      nose: "девочка нажала тебе на нос на экране — тебе щекотно! Хихикни одной короткой фразой, например «Хи-хи, щекотно!».",
      belly: "девочка пощекотала тебе животик на экране — засмейся одной короткой фразой." }[zone];
    if (!noteQueue.some((n) => n.includes("на экране — "))) { note(txt); lastTapNote = now; }
  }
});

/* ---------------- animation ---------------- */
const sheriff = $("sheriff"), mouth = $("mouth"), blinkEl = $("blink");
let level = 0, nextBlink = performance.now() + 2500, blinkUntil = 0, mouthOpen = false;
const tbuf = new Float32Array(1024);
function frame(now) {
  let rms = 0;
  if (analyser && isSpeaking()) {
    analyser.getFloatTimeDomainData(tbuf);
    let s = 0; for (let i = 0; i < tbuf.length; i++) s += tbuf[i] * tbuf[i];
    rms = Math.sqrt(s / tbuf.length);
  }
  level += ((rms > level ? 0.6 : 0.25)) * (rms - level);
  // mouth with hysteresis for cartoon flap
  if (!mouthOpen && level > 0.035) mouthOpen = true; else if (mouthOpen && level < 0.02) mouthOpen = false;
  const t = now / 1000;
  const flap = Math.sin(t * 15) + 0.35 * Math.sin(t * 23) > -0.35; // syllable-like chatter
  mouth.style.opacity = (mouthOpen && (flap || level > 0.12)) ? Math.min(1, 0.6 + level * 6).toFixed(2) : "0";
  const breathe = Math.sin(t * 1.6) * 0.012;
  const talk = Math.min(level * 4, 0.6);
  const listening = app.classList.contains("listening");
  const tilt = listening ? -6 : Math.sin(t * 0.7) * 1.5 + Math.sin(t * 7.3) * talk * 4;
  const bounce = -Math.abs(Math.sin(t * 9)) * talk * 14;
  sheriff.style.transform = `translateY(${bounce.toFixed(1)}px) rotate(${tilt.toFixed(2)}deg) scale(${(1 + breathe + talk * 0.05).toFixed(4)}, ${(1 - breathe * 0.4 + talk * 0.06).toFixed(4)})`;
  guests.forEach((g) => {
    g.an.getFloatTimeDomainData(tbuf); let q = 0; for (let i = 0; i < tbuf.length; i++) q += tbuf[i] * tbuf[i]; const r = Math.sqrt(q / tbuf.length);
    g.level += (r > g.level ? 0.6 : 0.25) * (r - g.level);
    if (!g.open && g.level > 0.035) g.open = true; else if (g.open && g.level < 0.02) g.open = false;
    g.mouth.style.opacity = g.open && (flap || g.level > 0.12) ? Math.min(1, 0.6 + g.level * 6).toFixed(2) : "0";
    const gt = Math.min(g.level * 4, 0.6);
    g.body.style.transform = `translateY(${(-Math.abs(Math.sin(t * 9 + 1)) * gt * 14).toFixed(1)}px) rotate(${(Math.sin(t * 0.8 + 2) * 1.5 + Math.sin(t * 7.1) * gt * 4).toFixed(2)}deg) scale(${(1 + Math.sin(t * 1.5 + 1) * 0.012).toFixed(4)})`;
    if (now > g.nextBlink) { g.blinkUntil = now + 140; g.nextBlink = now + 2400 + Math.random() * 3800; }
    g.blink.style.opacity = now < g.blinkUntil ? "1" : "0";
  });
  if (now > nextBlink) { blinkUntil = now + 140; nextBlink = now + 2200 + Math.random() * 3800; if (Math.random() < 0.2) nextBlink = now + 320; }
  blinkEl.style.opacity = now < blinkUntil ? "1" : "0";
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if (DEBUG) setInterval(() => { if (S.state === "incall") $("debug").dataset.x = 1, log("mic rms", (S.micRms || 0).toFixed(3), "gate", S.gate); }, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && ctx && ctx.state === "suspended") ctx.resume(); });
})();
