(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const app = $("app");
const params = new URLSearchParams(location.search);
const DEBUG = params.has("debug");
if (DEBUG) app.classList.add("debug");
const BARGE_RMS = parseFloat(params.get("barge") || "0.06");
const MAX_CALL_MS = 20 * 60 * 1000;
const RATE = 24000;

const S = window.__sheriff = {
  state: "idle", events: [], audioChunks: 0, audioSamples: 0, transcripts: [], userTranscripts: [], errors: [],
  sessionCreated: false, sessionUpdated: false, speechStarted: 0,
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
let resampPos = 0, pending = [], pendingLen = 0, loudRun = 0;

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
function playPcm16(b64) {
  const bin = atob(b64); const n = bin.length >> 1;
  if (!n) return;
  const buf = ctx.createBuffer(1, n, RATE); const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; ch[i] = v / 32768; }
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(outGain);
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
const workletCode = `class Cap extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('cap',Cap);`;
async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const url = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
  await ctx.audioWorklet.addModule(url);
  micSource = ctx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(ctx, "cap");
  workletNode.port.onmessage = (e) => onMicFrame(e.data);
  const sink = ctx.createGain(); sink.gain.value = 0;
  micSource.connect(workletNode); workletNode.connect(sink); sink.connect(ctx.destination);
}
function onMicFrame(f32) {
  // resample ctx.sampleRate -> 24000 (linear)
  const ratio = ctx.sampleRate / RATE;
  const out = [];
  while (resampPos < f32.length - 1) {
    const i = Math.floor(resampPos), fr = resampPos - i;
    out.push(f32[i] * (1 - fr) + f32[i + 1] * fr);
    resampPos += ratio;
  }
  resampPos -= f32.length;
  if (resampPos < 0) resampPos = 0;
  pending.push(Float32Array.from(out)); pendingLen += out.length;
  if (pendingLen >= RATE / 10) flushMic();
}
function flushMic() {
  const all = new Float32Array(pendingLen); let o = 0;
  pending.forEach((p) => { all.set(p, o); o += p.length; });
  pending = []; pendingLen = 0;
  let sum = 0; for (let i = 0; i < all.length; i++) sum += all[i] * all[i];
  const rms = Math.sqrt(sum / all.length); S.micRms = rms;
  let send = !muted;
  // echo guard: while Sheriff talks, only pass clearly loud speech (barge-in)
  if (send && ctx.currentTime < nextPlay + 0.3) {
    loudRun = rms > BARGE_RMS ? loudRun + 1 : 0;
    if (loudRun < 2) send = false;
  } else loudRun = 0;
  const pcm = new Int16Array(all.length);
  if (send) for (let i = 0; i < all.length; i++) { const s = Math.max(-1, Math.min(1, all[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  if (ws && ws.readyState === 1 && S.sessionUpdated) {
    const u8 = new Uint8Array(pcm.buffer); let bin = "";
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: btoa(bin) }));
  }
}

/* ---------------- realtime session ---------------- */
async function connect(isReconnect) {
  const r = await fetch("api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice: params.get("voice") || "" }) });
  if (!r.ok) throw new Error("Сервер не дал ключ (" + r.status + ")");
  const cfg = await r.json();
  return new Promise((resolve, reject) => {
    const sock = new WebSocket("wss://api.x.ai/v1/realtime?model=" + encodeURIComponent(cfg.model || "grok-voice-latest"), ["xai-client-secret." + cfg.token]);
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; try { sock.close(); } catch (e) {} reject(new Error("timeout")); } }, 6000);
    sock.onmessage = (m) => {
      if (typeof m.data !== "string") return;
      const e = JSON.parse(m.data);
      if (e.type === "session.created" && !done) {
        done = true; clearTimeout(to); S.sessionCreated = true;
        sock.send(JSON.stringify({ type: "session.update", session: cfg.session }));
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
function sayAsUser(text) {
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
        if (firstUpdate) {
          firstUpdate = false; S.sessionUpdated = true;
          if (S.state === "ringing") enterCall();
          sayAsUser(isReconnect
            ? "(Служебная заметка, не читай вслух: связь на секунду прервалась и восстановилась. Весело скажи, что связь вернулась, и продолжай болтать с девочкой.)"
            : "(Служебная заметка, не читай вслух: маленькая девочка только что позвонила тебе по видеосвязи. Радостно поздоровайся первым, коротко представься как Шериф и спроси, как её зовут.)");
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
      case "response.created": captionText = ""; break;
      case "response.output_item.added": curItem = e.item && e.item.id; curItemStart = Math.max(ctx.currentTime, nextPlay); break;
      case "response.output_audio.delta": app.classList.remove("listening"); playPcm16(e.delta); break;
      case "response.output_audio_transcript.delta": captionText += e.delta || ""; showCaption(captionText); break;
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
let capTimer;
function showCaption(t) {
  const words = t.split(/\s+/); const tail = words.slice(-18).join(" ");
  $("caption").innerHTML = "<span></span>"; $("caption").firstChild.textContent = tail;
  clearTimeout(capTimer); capTimer = setTimeout(() => { $("caption").innerHTML = ""; }, 6000);
}

/* ---------------- call flow ---------------- */
async function startCall() {
  $("err").textContent = "";
  hangingUp = false; reconnects = 0; goodbyeSent = false;
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  if (!outGain) {
    outGain = ctx.createGain(); outGain.gain.value = 1.0;
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    outGain.connect(analyser); outGain.connect(ctx.destination);
  }
  setState("ringing");
  $("lobbyTitle").textContent = "Звоним Шерифу…";
  $("lobbySub").textContent = "Сейчас он возьмёт трубку 🐶";
  startRinging();
  const ringMin = new Promise((r) => setTimeout(r, 2600));
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("nomedia");
    await startMic();
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
      .then((s) => { camStream = s; $("selfie").srcObject = s; }).catch((e) => log("no camera", String(e)));
    await ringMin;
    if (hangingUp) return;
    await connectWithRetry(false);
  } catch (e) {
    log("start error", String(e && e.message || e));
    if (hangingUp) return;
    if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) fail("Разреши, пожалуйста, микрофон — без него Шериф тебя не услышит 🎤");
    else if (String(e.message) === "nomedia") fail("Этот браузер не даёт микрофон. Открой страницу в Safari или Chrome по https.");
    else fail("Шериф пока не отвечает. Попробуй ещё раз! (" + (e.message || e) + ")");
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
  $("caption").innerHTML = "";
}
function hangUp() {
  hangingUp = true; cleanup(); blip(700, 300);
  setState("idle");
  $("lobbyTitle").textContent = "Пока-пока! 👋";
  $("lobbySub").textContent = "Шериф будет ждать твоего звонка";
  $("callBtn").querySelector("span").textContent = "Позвонить ещё раз";
}
function fail(msg) {
  hangingUp = true; cleanup(); setState("idle");
  $("lobbyTitle").textContent = "Шериф";
  $("lobbySub").textContent = "Полицейский участок • на связи 🚓";
  $("err").textContent = msg;
}
$("callBtn").addEventListener("click", startCall);
$("hangBtn").addEventListener("click", hangUp);
$("cancelBtn").addEventListener("click", hangUp);
$("micBtn").addEventListener("click", () => { muted = !muted; $("micBtn").classList.toggle("off", muted); $("micBtn").textContent = muted ? "🔇" : "🎤"; });
$("ccBtn").addEventListener("click", () => app.classList.toggle("cc"));
if (params.has("cc")) app.classList.add("cc");

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
  if (now > nextBlink) { blinkUntil = now + 140; nextBlink = now + 2200 + Math.random() * 3800; if (Math.random() < 0.2) nextBlink = now + 320; }
  blinkEl.style.opacity = now < blinkUntil ? "1" : "0";
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
document.addEventListener("visibilitychange", () => { if (!document.hidden && ctx && ctx.state === "suspended") ctx.resume(); });
})();
