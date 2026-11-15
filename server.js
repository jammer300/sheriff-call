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
const persona = fs.readFileSync(path.join(__dirname, "persona.md"), "utf8");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.get("/healthz", (_, res) => res.json({ ok: true, ctx: CHILD_CONTEXT ? "set" : "none" }));
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
  console.log(new Date().toISOString(), "call start", JSON.stringify({ voice: session.voice, turn: session.turn_detection, rate: session.audio.input.format.rate, ctx: !!CHILD_CONTEXT }));
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
