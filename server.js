// Sheriff call server: serves the page and proxies the xAI realtime WebSocket.
// The API key, the persona and the private child context never reach the browser:
// the server configures the session itself and strips instructions from events it forwards.
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const KEY = process.env.XAI_API_KEY || process.env.LLM_API_KEY;
const PORT = process.env.PORT || 8787;
const VOICE = process.env.SHERIFF_VOICE || "rex";
const MODEL = process.env.SHERIFF_MODEL || "grok-voice-latest";
const VAD_THRESHOLD = parseFloat(process.env.VAD_THRESHOLD || "0.35");
const VAD_SILENCE_MS = parseInt(process.env.VAD_SILENCE_MS || "1000", 10);
const VAD_PREFIX_MS = parseInt(process.env.VAD_PREFIX_MS || "500", 10);
const CHILD_CONTEXT = (process.env.CHILD_CONTEXT || "").trim();          // private, set only in Render env
const CHILD_KEYTERMS = (process.env.CHILD_KEYTERMS || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 90);
const CHILD_ROUTINE = (process.env.CHILD_ROUTINE || "").trim();          // private, set only in Render env
const TZ = process.env.SHERIFF_TZ || "Asia/Makassar";
const TZ_LABEL = process.env.SHERIFF_TZ_LABEL || "по Бали";
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function timeContext(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  const h = parseInt(parts.hour, 10) % 24, m = parseInt(parts.minute, 10);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const part = h < 5 ? "ночь" : h < 12 ? "утро" : h < 17 ? "день" : h < 22 ? "вечер" : "ночь";
  const partGen = { "ночь": "ночи", "утро": "утра", "день": "дня", "вечер": "вечера" }[part];
  const weekend = wd === 0 || wd === 6;
  return {
    h, m, wd, weekend,
    text: `Сейчас ${WEEKDAYS[wd]}, ${parts.day} ${MONTHS[parseInt(parts.month, 10) - 1]}, ${h}:${String(m).padStart(2, "0")} ${partGen} ${TZ_LABEL} (${part}; ${weekend ? "выходной день" : "будний день"}).`,
  };
}
function momentHint(h) {
  if (h >= 5 && h < 10) return "early morning — how she slept, breakfast, plans for the day";
  if (h >= 10 && h < 12) return "late morning — what she is doing or playing right now, plans for today; lunch is coming soon (do NOT ask how she slept, it is too late for that)";
  if (h >= 12 && h < 15) return "midday — lunch, what she did this morning";
  if (h >= 15 && h < 19) return "afternoon — how her day went, snack, play, dinner soon";
  if (h >= 19 && h < 21) return "evening — dinner, getting ready for bed, brushing teeth, a bedtime story";
  return "late night — she should be sleeping: be very soft, short, and kindly suggest it is time to sleep, then say a warm goodnight";
}
const persona = fs.readFileSync(path.join(__dirname, "persona.md"), "utf8");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.get("/healthz", (_, res) => res.json({ ok: true, ctx: CHILD_CONTEXT ? "set" : "none", routine: CHILD_ROUTINE ? "set" : "none", now: timeContext().text }));
const server = http.createServer(app);

// simple abuse guard (public URL)
const hits = [];
function allowed() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 3600e3) hits.shift();
  if (hits.length >= 60) return false;
  hits.push(now); return true;
}
const num = (v, lo, hi, d) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000];

function buildSession(q) {
  const turn = {
    type: "server_vad",
    threshold: num(q.get("vad"), 0.05, 0.95, VAD_THRESHOLD),
    silence_duration_ms: Math.round(num(q.get("silence"), 200, 3000, VAD_SILENCE_MS)),
    prefix_padding_ms: Math.round(num(q.get("prefix"), 0, 2000, VAD_PREFIX_MS)),
    idle_timeout_ms: 25000,
  };
  const name = (q.get("name") || "").trim().slice(0, 30).replace(/[^\p{L}\p{M} -]/gu, "");
  let instructions = persona;
  const t = timeContext();
  instructions += "\n\n## Current time\n- " + t.text +
    "\n- Right now it fits to talk about: " + momentHint(t.h) + "." +
    "\n- Use the time naturally, ONE question at a time, never like an interview. Do not say the exact clock time unless she asks or it really matters. The call lasts at most 20 minutes, so this time stays valid for the whole call.";
  if (CHILD_ROUTINE) instructions += "\n\n## Her daily routine (private; use it with the current time above)\n" + CHILD_ROUTINE;
  if (CHILD_CONTEXT) instructions += "\n\n## Known facts about the girl (private; you already know her)\n" + CHILD_CONTEXT;
  else if (name) instructions += `\n\n## Known facts\n- The girl's name is probably "${name}". If what you hear sounds even a little like "${name}", it is her name.`;
  const keyterms = ["Шериф", "Гав", ...CHILD_KEYTERMS]; if (name) keyterms.push(name);
  const rate = RATES.includes(parseInt(q.get("rate"), 10)) ? parseInt(q.get("rate"), 10) : 24000;
  const voice = /^[a-z0-9_-]{2,40}$/i.test(q.get("voice") || "") ? q.get("voice") : VOICE;
  return {
    voice, instructions, turn_detection: turn,
    audio: {
      input: { format: { type: "audio/pcm", rate }, transcription: { language_hint: "ru", keyterms: [...new Set(keyterms)].slice(0, 100) } },
      output: { format: { type: "audio/pcm", rate: 24000 } },
    },
  };
}

// events the browser may send upstream
const CLIENT_OK = new Set(["input_audio_buffer.append", "input_audio_buffer.clear", "conversation.item.create", "conversation.item.truncate", "response.create", "response.cancel"]);
function scrub(e) {
  // never echo instructions (persona + private context) back to the browser
  if (e.session) { delete e.session.instructions; if (e.session.audio && e.session.audio.input && e.session.audio.input.transcription) delete e.session.audio.input.transcription.keyterms; }
  if (e.response && e.response.instructions) delete e.response.instructions;
  return e;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
server.on("upgrade", (req, sock, head) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname !== "/rt") return sock.destroy();
  if (!allowed()) { sock.write("HTTP/1.1 429 Too Many Requests\r\n\r\n"); return sock.destroy(); }
  wss.handleUpgrade(req, sock, head, (client) => bridge(client, u.searchParams));
});

function bridge(client, q) {
  const session = buildSession(q);
  console.log(new Date().toISOString(), "call start", JSON.stringify({ voice: session.voice, turn: session.turn_detection, rate: session.audio.input.format.rate, ctx: !!CHILD_CONTEXT, routine: !!CHILD_ROUTINE, time: timeContext().text }));
  const up = new WebSocket("wss://api.x.ai/v1/realtime?model=" + encodeURIComponent(MODEL), { headers: { Authorization: `Bearer ${KEY}` } });
  const queue = []; let configured = false;
  const started = Date.now();
  const maxTimer = setTimeout(() => { try { client.close(4000, "max call length"); } catch (e) {} }, 21 * 60 * 1000);
  up.on("message", (data, isBinary) => {
    if (isBinary) return;
    let e; try { e = JSON.parse(data.toString()); } catch { return; }
    if (e.type === "session.created" && !configured) {
      configured = true;
      up.send(JSON.stringify({ type: "session.update", session }));
      queue.splice(0).forEach((m) => up.send(m));
    }
    if (client.readyState === 1) client.send(JSON.stringify(scrub(e)));
  });
  client.on("message", (data, isBinary) => {
    if (isBinary) return;
    let e; try { e = JSON.parse(data.toString()); } catch { return; }
    if (!CLIENT_OK.has(e.type)) return;
    const m = JSON.stringify(e);
    if (configured && up.readyState === 1) up.send(m); else if (queue.length < 50) queue.push(m);
  });
  let ended = false;
  const end = (why) => {
    if (ended) return; ended = true;
    clearTimeout(maxTimer);
    try { up.close(); } catch (e) {} try { client.close(); } catch (e) {}
    if (why) console.log(new Date().toISOString(), "call end", why, Math.round((Date.now() - started) / 1000) + "s");
  };
  up.on("close", (c) => end("upstream " + c));
  up.on("error", (err) => { console.error("upstream error", err.message); end("upstream error"); });
  client.on("close", () => end("client closed"));
  client.on("error", () => end("client error"));
}

server.listen(PORT, () => console.log("sheriff-call on", PORT, CHILD_CONTEXT ? "(child context set)" : "(no child context)"));
