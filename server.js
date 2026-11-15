// Sheriff call server: serves the page and proxies the xAI realtime WebSocket.
// The API key, the persona and the private child context never reach the browser:
// the server configures the session itself and strips instructions from events it forwards.
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");
const memory = require("./memory");
const { toolsFor, NAMES } = require("./tools");

const KEY = process.env.XAI_API_KEY || process.env.LLM_API_KEY;
const PORT = process.env.PORT || 8787;
const MODEL = process.env.SHERIFF_MODEL || "grok-voice-latest";
const VAD_THRESHOLD = parseFloat(process.env.VAD_THRESHOLD || "0.35");
const VAD_SILENCE_MS = parseInt(process.env.VAD_SILENCE_MS || "1000", 10);
const VAD_PREFIX_MS = parseInt(process.env.VAD_PREFIX_MS || "500", 10);
const CHILD_CONTEXT = (process.env.CHILD_CONTEXT || "").trim();          // private, set only in Render env
const CHILD_KEYTERMS = (process.env.CHILD_KEYTERMS || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 90);
const CHILD_ROUTINE = (process.env.CHILD_ROUTINE || "").trim();          // private, set only in Render env
const PARENT_KEY = (process.env.PARENT_KEY || "").trim();                // private, set only in Render env
const TEXT_MODEL = process.env.TEXT_MODEL || "grok-4.20-0309-non-reasoning";
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
const GUEST_SHEET = {
  sheriff: "Шериф (Sheriff Labrador): male, the wise and kind chief, a yellow Labrador; says «Гав!»; masculine grammar (рад, видел).",
  papillon: "Папийон: female, the youngest officer and inventor with a backpack of gadgets, flies the helicopter, giggles, says «У Папийон всегда есть идея!», «Бип-бип!»; ALWAYS feminine grammar (рада, видела, придумала).",
  dobie: "Доби: male, a brave, excitable, a bit clumsy Doberman who loves snacks, says «Ух ты-ух ты!»; masculine grammar (рад, видел).",
};
const personaTpl = fs.readFileSync(path.join(__dirname, "persona.md"), "utf8");
const CHARS = JSON.parse(fs.readFileSync(path.join(__dirname, "characters.json"), "utf8"));
if (process.env.SHERIFF_VOICE) CHARS.sheriff.voice = process.env.SHERIFF_VOICE;
function personaFor(c) {
  const ch = CHARS[c];
  return personaTpl.replace("{{ROLE}}", ch.role).replace("{{GAMES}}", ch.games).replace("{{STORIES}}", ch.stories)
    .replace("{{SOUNDS}}", ch.sounds).replace("{{HEARD}}", ch.heard).replace("{{STAY}}", ch.stay).replace("{{GENDER_RULE}}", ch.gender);
}


// ---------- memory across calls (private) ----------
const fmtBali = (d) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(d));
async function memoryText() {
  let rows = [];
  try { rows = (await memory.recent(12)).filter((r) => r.summary); } catch (e) { console.error("memory read", e.message); return ""; }
  if (!rows.length) return "";
  const out = [];
  const last = rows[0];
  out.push(`- Last call: ${fmtBali(last.started_at)} (${TZ_LABEL}), she talked with ${CHARS[last.char] ? CHARS[last.char].name : last.char}. ${last.summary.summary || ""}`);
  rows.slice(1, 3).forEach((r) => r.summary.summary && out.push(`- Earlier (${fmtBali(r.started_at)}, ${CHARS[r.char] ? CHARS[r.char].name : r.char}): ${r.summary.summary}`));
  const qs = [...new Set(rows.slice(0, 3).flatMap((r) => r.summary.questions || []))].slice(0, 6);
  if (qs.length) out.push("- Her recent questions: " + qs.map((q) => `«${q}»`).join("; "));
  const facts = [...new Set(rows.slice(0, 8).flatMap((r) => r.summary.facts || []))].slice(0, 10);
  if (facts.length) out.push("- Things she told you: " + facts.join("; "));
  const st = rows.find((r) => r.summary.story && r.summary.story.status && r.summary.story.status !== "none");
  if (st) {
    const s = st.summary.story;
    out.push(s.status === "ongoing"
      ? `- UNFINISHED ADVENTURE «${s.title || ""}»: ${s.where_we_stopped || ""} Next idea: ${s.next || ""}`
      : `- Last finished adventure: «${s.title || ""}» (${s.where_we_stopped || ""}). Next time you can start a NEW adventure.`);
  }
  return out.join("\n");
}
async function grokText(messages, max_tokens = 600, json = false) {
  const body = { model: TEXT_MODEL, messages, max_tokens, temperature: 0.3 };
  if (json) body.response_format = { type: "json_object" };
  const r = await fetch("https://api.x.ai/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("grok " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}
async function summarize(char, transcript) {
  const text = transcript.map((t) => `${t.r === "child" ? "Девочка" : t.r === "fn" ? "[экран]" : t.r === "guest" ? (NAMES[t.who] || "друг") : CHARS[char].name}: ${t.t}`).join("\n").slice(-14000);
  const d = await grokText([
    { role: "system", content: "Ты помогаешь родителям вести дневник звонков их маленькой дочки мультяшному герою (полицейской собаке). По расшифровке звонка (распознавание речи ребёнка может быть неточным) верни JSON:\n{\"summary\": \"2–3 коротких предложения по-русски: о чём говорили, во что играли\", \"questions\": [\"вопросы, которые САМА девочка задала герою, дословно или близко\"], \"facts\": [\"новые факты, которые девочка рассказала о себе (что делала, что любит, планы), коротко\"], \"story\": {\"title\": \"название приключения, если герой рассказывал историю\", \"status\": \"ongoing|finished|none\", \"where_we_stopped\": \"на чём остановились, 1–2 предложения\", \"next\": \"что может быть дальше\"}, \"games\": [\"в какие игры играли\"], \"mood\": \"настроение девочки одним-двумя словами\"}\nНе выдумывай. Пустые списки, если ничего нет." },
    { role: "user", content: text },
  ], 700, true);
  return JSON.parse(d.choices[0].message.content);
}
const VISION_PROMPT = "Ты — глаза мультяшного героя на видеозвонке с ребёнком (иногда в кадре взрослый). Человек что-то показывает в камеру. Внимательно рассмотри кадр и по-русски, коротко и ТОЧНО опиши, что показывают:\n- Руки и жесты: если в кадре рука — сколько пальцев поднято (посчитай каждый палец внимательно, большой палец тоже), какой жест (пять пальцев/ладошка, «викторина/V», большой палец вверх, кулак, машет рукой, сердечко).\n- Предметы в руках или у камеры: что это (игрушка, рисунок, еда, книжка…), цвет, пара деталей; сколько их, если несколько.\n- Крупные буквы или цифры на рисунке/игрушке/карточке — какие (но не читай адреса, документы, экраны).\nЛицо и внешность людей НЕ описывай, но руки, жесты и предметы описывай всегда. Если что-то не видно чётко (размыто, темно, обрезано) — так и скажи и честно укажи, в чём не уверен, не выдумывай. Если ничего не показывают, скажи «ничего не показывают, видно только человека». 1–2 предложения, обычный текст без markdown.";
const VISION_MODEL = process.env.VISION_MODEL || "grok-4.7";            // strongest vision, ~3–5 s
const VISION_FAST = process.env.VISION_FAST_MODEL || "grok-4.20-0309-non-reasoning"; // ~1 s backup
async function visionCall(model, b64, extra, signal) {
  const t0 = Date.now();
  const body = { model, max_tokens: 400, temperature: 0.1, ...extra, messages: [
    { role: "system", content: VISION_PROMPT },
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64, detail: "high" } }, { type: "text", text: "Что показывают в камеру?" }] }] };
  const r = await fetch("https://api.x.ai/v1/chat/completions", { method: "POST", signal, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(model + " " + r.status + " " + (await r.text()).slice(0, 160));
  const d = await r.json();
  const text = (d.choices[0].message.content || "").replace(/[*_#`]+/g, "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(model + " empty");
  return { model, text, ms: Date.now() - t0, cost: d.usage && d.usage.cost_in_usd_ticks ? d.usage.cost_in_usd_ticks / 1e10 : 0 };
}
// Ask the strong model and a fast model in parallel: prefer the strong answer if it comes within
// PREFER_MS, otherwise take the fast one; give up after HARD_MS (the caller always answers the model).
async function describeImage(b64) {
  const PREFER_MS = 6000, HARD_MS = 9000, t0 = Date.now();
  const ac = new AbortController(); const kill = setTimeout(() => ac.abort(), HARD_MS);
  const strong = visionCall(VISION_MODEL, b64, /grok-4\.(5|6|7)/.test(VISION_MODEL) ? { reasoning_effort: "low" } : {}, ac.signal);
  const fast = visionCall(VISION_FAST, b64, {}, ac.signal);
  strong.catch(() => {}); fast.catch(() => {});
  const timeout = (ms) => new Promise((res) => setTimeout(() => res(null), ms));
  try {
    let r = await Promise.race([strong, timeout(PREFER_MS)]).catch(() => null);
    if (!r) r = await Promise.any([fast, strong]).catch(() => null);
    if (!r) throw new Error("no vision answer");
    const costP = Promise.allSettled([strong, fast]).then((all) => { clearTimeout(kill); return all.reduce((s, x) => s + (x.status === "fulfilled" ? x.value.cost : 0), 0); });
    return { text: r.text, ms: Date.now() - t0, model: r.model, costP };
  } catch (e) { clearTimeout(kill); throw e; }
}

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
const DEBUG_LOOK = process.env.DEBUG_LOOK === "1";
const RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000];

function buildSession(q, memText) {
  const turn = {
    type: "server_vad",
    threshold: num(q.get("vad"), 0.05, 0.95, VAD_THRESHOLD),
    silence_duration_ms: Math.round(num(q.get("silence"), 200, 3000, VAD_SILENCE_MS)),
    prefix_padding_ms: Math.round(num(q.get("prefix"), 0, 2000, VAD_PREFIX_MS)),
    idle_timeout_ms: 25000,
  };
  const name = (q.get("name") || "").trim().slice(0, 30).replace(/[^\p{L}\p{M} -]/gu, "");
  const c = CHARS[q.get("c")] ? q.get("c") : "sheriff";
  let instructions = personaFor(c);
  const t = timeContext();
  instructions += "\n\n## Current time\n- " + t.text +
    "\n- Right now it fits to talk about: " + momentHint(t.h) + "." +
    "\n- Use the time naturally, ONE question at a time, never like an interview. Do not say the exact clock time unless she asks or it really matters. The call lasts at most 20 minutes, so this time stays valid for the whole call.";
  if (CHILD_ROUTINE) instructions += "\n\n## Her daily routine (private; use it with the current time above)\n" + CHILD_ROUTINE;
  if (CHILD_CONTEXT) instructions += "\n\n## Known facts about the girl (private; you already know her)\n" + CHILD_CONTEXT;
  else if (name) instructions += `\n\n## Known facts\n- The girl's name is probably "${name}". If what you hear sounds even a little like "${name}", it is her name.`;
  if (memText) instructions += "\n\n## Memory of previous calls (private; from your earlier calls with her)\n" + memText +
    "\n- Use this memory like a real friend: near the start mention ONE thing from last time naturally («В прошлый раз ты мне рассказала…» / «В прошлый раз мы искали…»), and if an adventure is unfinished, offer to continue it. Do not read the memory out as a list.";
  instructions += "\n\n## Group calls (friends joining)\n" +
    "- You are the host of this call. Your friends can join with invite_friend (she may ask «позови Доби!», or there is a note that she pressed a button). Then they appear on her screen next to you.\n" +
    "- A friend speaks ONLY through friend_says (it plays in the friend's own voice). Never say a friend's words in your own voice and never say «Доби говорит…» — just call friend_says.\n" +
    "- Friends: " + Object.keys(NAMES).filter((k) => k !== c).map((k) => GUEST_SHEET[k]).join(" ") + "\n" +
    "- When a friend joins, let them greet her by name via friend_says. Then keep a lively, natural banter: a short friend line, a short line from you, and a question to her. If she talks to a friend by name, call friend_says for that friend RIGHT AWAY, without saying anything yourself first (no «Спрашивай у Доби!», no friend catchphrases in your voice); you may add one short line after the friend. Friends' lines are short (1–2 sentences). Do not let friends talk too long to each other; she is the star.\n" +
    "- Friends can join games and adventures (e.g. Папийон flies the helicopter, Доби finds a snack clue).";
  const keyterms = ["Шериф", "Гав", ...CHILD_KEYTERMS]; if (name) keyterms.push(name);
  const rate = RATES.includes(parseInt(q.get("rate"), 10)) ? parseInt(q.get("rate"), 10) : 24000;
  const voice = /^[a-z0-9_-]{2,40}$/i.test(q.get("voice") || "") ? q.get("voice") : CHARS[c].voice;
  return {
    _char: c,
    voice, instructions, turn_detection: turn, tools: toolsFor(c), tool_choice: "auto",
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

const wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024 });
server.on("upgrade", (req, sock, head) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname !== "/rt") return sock.destroy();
  if (!allowed()) { sock.write("HTTP/1.1 429 Too Many Requests\r\n\r\n"); return sock.destroy(); }
  wss.handleUpgrade(req, sock, head, (client) => bridge(client, u.searchParams));
});

function bridge(client, q) {
  const memP = memoryText().catch(() => "");
  const upstream = new WebSocket("wss://api.x.ai/v1/realtime?model=" + encodeURIComponent(MODEL), { headers: { Authorization: `Bearer ${KEY}` } });
  const up = upstream;
  const queue = []; let configured = false, session = null, charId = "sheriff";
  const started = new Date();
  const transcript = []; let looks = 0;
  const maxTimer = setTimeout(() => { try { client.close(4000, "max call length"); } catch (e) {} }, 21 * 60 * 1000);
  const toClient = (o) => { if (client.readyState === 1) client.send(JSON.stringify(o)); };
  const toUp = (o) => { if (up.readyState === 1) up.send(JSON.stringify(o)); };
  up.on("message", async (data, isBinary) => {
    if (isBinary) return;
    let e; try { e = JSON.parse(data.toString()); } catch { return; }
    if (e.type === "session.created" && !configured) {
      configured = true;
      const memText = await memP;
      session = buildSession(q, memText);
      charId = session._char; delete session._char;
      console.log(new Date().toISOString(), "call start", JSON.stringify({ char: charId, voice: session.voice, turn: session.turn_detection, rate: session.audio.input.format.rate, ctx: !!CHILD_CONTEXT, routine: !!CHILD_ROUTINE, memory: memText ? memText.length : 0, time: timeContext().text }));
      up.send(JSON.stringify({ type: "session.update", session }));
      queue.splice(0).forEach((m) => up.send(m));
    }
    if (e.type === "conversation.item.input_audio_transcription.completed" && e.transcript) transcript.push({ r: "child", t: e.transcript });
    if (e.type === "response.output_audio_transcript.done" && e.transcript) transcript.push({ r: "char", t: e.transcript });
    if (e.type === "response.function_call_arguments.done") transcript.push({ r: "fn", t: e.name + " " + (e.arguments || "") });
    if (e.type === "session.updated" && e.session && e.session.tools) e.session.tools = e.session.tools.length;
    toClient(scrub(e));
  });
  client.on("message", async (data, isBinary) => {
    if (isBinary) return;
    let e; try { e = JSON.parse(data.toString()); } catch { return; }
    if (e.type === "x.look") return look(e);
    if (e.type === "x.tts") return tts(e);
    if (!CLIENT_OK.has(e.type)) return;
    if (e.type === "conversation.item.create" && e.item && e.item.type === "message") {
      const t = e.item.content && e.item.content[0] && e.item.content[0].text; if (t) transcript.push({ r: "note", t: String(t).slice(0, 300) });
    }
    const m = JSON.stringify(e);
    if (configured && session && up.readyState === 1) up.send(m); else if (queue.length < 50) queue.push(m);
  });
  // The browser sends ONE downscaled webcam frame; we describe it with a vision model and hand the
  // text to the voice model. The frame is kept only in memory for this request and never stored.
  let lookBusy = false, lastLook = null, lookFails = 0;
  const HONEST = "Say ONLY what is in this description; if it says something is unclear, honestly say you could not see it well and ask her to show it again closer and slower. Never guess numbers you were not told.";
  async function look(e) {
    const callId = typeof e.call_id === "string" ? e.call_id.slice(0, 100) : null;
    let result;
    try {
      if (lookBusy) result = { ok: false, error: "You are already looking — wait for that answer. Do not call look_at_camera again now." };
      else if (lastLook && Date.now() - lastLook.at < 3000) result = { ...lastLook.result, note: "Same picture as a moment ago. Do not call look_at_camera again until she shows something new." };
      else if (looks >= 40) result = { ok: false, error: "Camera is resting now. Ask her to tell you about it with words." };
      else if (!e.image || typeof e.image !== "string" || e.image.length > 2e6) result = { ok: false, error: "Camera is off. Ask her to tell you what it is." };
      else {
        looks++; lookBusy = true;
        try {
          const r = await describeImage(e.image.replace(/^data:image\/\w+;base64,/, ""));
          lookFails = 0;
          result = { ok: true, you_see: r.text, note: HONEST };
          r.costP.then((c) => console.log(new Date().toISOString(), "look", r.model, r.ms + "ms", "$" + c.toFixed(4), Math.round(e.image.length * 0.75 / 1024) + "KB", JSON.stringify(r.text).slice(0, 200)));
          transcript.push({ r: "fn", t: "look: " + r.text });
          toClient({ type: "x.look.result", ms: r.ms, model: r.model, text: DEBUG_LOOK ? r.text : undefined });
        } catch (err) {
          lookFails++;
          console.error("look error", err.message);
          result = { ok: false, error: lookFails >= 2
            ? "The camera picture did not work again. Do NOT call look_at_camera again; kindly ask her to tell you with words what she is showing."
            : "Could not see the picture this time. Say «Не разглядел(а), покажи ещё раз поближе!» and wait." };
        }
      }
    } catch (err) { result = { ok: false, error: "camera error — ask her to tell you with words" }; }
    finally { lookBusy = false; }
    lastLook = { at: Date.now(), result };
    if (callId) toUp({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) } });
    else toUp({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: result.ok
      ? `(Служебная заметка, не читай вслух: девочка нажала кнопку «Покажи» и показала тебе в камеру вот что: ${result.you_see} Отреагируй радостно и с интересом, похвали, спроси про это ОДИН простой вопрос. Говори только о том, что в описании; если там написано, что что-то неясно — честно скажи, что не разглядел, и попроси показать ещё раз поближе.)`
      : "(Служебная заметка, не читай вслух: девочка хотела что-то показать в камеру, но картинку не удалось разглядеть. Честно скажи, что не разглядел, и попроси показать ещё раз поближе или рассказать словами.)" }] } });
    toClient({ type: "x.look.done", call_id: callId, ok: !!result.ok });
  }

  // a friend in a group call speaks through text-to-speech in their own voice
  let ttsCount = 0;
  async function tts(e) {
    const who = NAMES[e.who] ? e.who : null, text = String(e.text || "").slice(0, 400);
    if (!who || !text || ++ttsCount > 120) return toClient({ type: "x.tts.audio", id: e.id, who, error: "rejected" });
    transcript.push({ r: "guest", who, t: text });
    try {
      const t0 = Date.now();
      const r = await fetch("https://api.x.ai/v1/tts", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice_id: CHARS[who].voice, language: "ru", output_format: { codec: "pcm", sample_rate: 24000 } }) });
      if (!r.ok) throw new Error("tts " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      console.log(new Date().toISOString(), "tts", who, text.length + "ch", Date.now() - t0 + "ms");
      toClient({ type: "x.tts.audio", id: e.id, who, text, audio: buf.toString("base64"), ms: Date.now() - t0 });
    } catch (err) { console.error("tts error", err.message); toClient({ type: "x.tts.audio", id: e.id, who, error: "failed" }); }
  }
  let ended = false;
  const end = (why) => {
    if (ended) return; ended = true;
    clearTimeout(maxTimer);
    try { up.close(); } catch (e) {} try { client.close(); } catch (e) {}
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(new Date().toISOString(), "call end", why, secs + "s", "turns", transcript.length);
    if (transcript.some((t) => t.r === "child") && memory.mode() !== "none") {
      summarize(charId, transcript).catch((err) => { console.error("summary error", err.message); return null; })
        .then((summary) => memory.saveCall({ started_at: started.toISOString(), ended_at: new Date().toISOString(), char: charId, seconds: secs, transcript, summary, looks }))
        .then(() => console.log("memory saved"), (err) => console.error("memory save error", err.message));
    }
  };
  up.on("close", (c) => end("upstream " + c));
  up.on("error", (err) => { console.error("upstream error", err.message); end("upstream error"); });
  client.on("close", () => end("client closed"));
  client.on("error", () => end("client error"));
}

// ---------- private parent page ----------
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function keyOk(k) {
  if (!PARENT_KEY || typeof k !== "string") return false;
  const a = Buffer.from(crypto.createHash("sha256").update(k).digest()), b = Buffer.from(crypto.createHash("sha256").update(PARENT_KEY).digest());
  return crypto.timingSafeEqual(a, b);
}
app.get("/parent", async (req, res) => {
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" });
  if (!keyOk(req.query.key)) return res.status(404).send("Not found");
  let rows = [], mem = "";
  try { rows = await memory.recent(100); mem = await memoryText(); } catch (e) { return res.status(500).send("memory error: " + esc(e.message)); }
  if (req.query.format === "json") return res.json({ memory: mem, calls: rows });
  const list = (a) => (a && a.length ? "<ul>" + a.map((x) => `<li>${esc(x)}</li>`).join("") + "</ul>" : "<i>—</i>");
  const cards = rows.map((r) => {
    const s = r.summary || {}; const st = s.story || {};
    const tr = (r.transcript || []).map((t) => `<div class="t ${t.r}"><b>${t.r === "child" ? "👧" : t.r === "char" ? esc(CHARS[r.char] ? CHARS[r.char].name : r.char) : t.r === "fn" ? "🖥" : t.r === "guest" ? esc(NAMES[t.who] || "друг") : "📝"}</b> ${esc(t.t)}</div>`).join("");
    return `<section><h2>${esc(fmtBali(r.started_at))} · ${esc(CHARS[r.char] ? CHARS[r.char].name : r.char)} · ${Math.round((r.seconds || 0) / 60)} мин${r.looks ? " · 👀 " + r.looks : ""}</h2>
      <p>${esc(s.summary || "(нет сводки)")}</p>
      <h3>❓ Её вопросы</h3>${list(s.questions)}
      <h3>💡 Что рассказала</h3>${list(s.facts)}
      ${st.status && st.status !== "none" ? `<h3>📖 Приключение: ${esc(st.title)} (${st.status === "ongoing" ? "продолжение следует" : "закончено"})</h3><p>${esc(st.where_we_stopped)} ${st.next ? "<br><i>Дальше: " + esc(st.next) + "</i>" : ""}</p>` : ""}
      ${s.games && s.games.length ? `<h3>🎲 Игры</h3><p>${esc(s.games.join(", "))}</p>` : ""}${s.mood ? `<p>Настроение: ${esc(s.mood)}</p>` : ""}
      <form method="post" action="/parent/delete?key=${encodeURIComponent(req.query.key)}" onsubmit="return confirm('Удалить этот звонок из памяти?')"><input type="hidden" name="id" value="${esc(r.id)}"><button>🗑 Удалить из памяти</button></form>
      <details><summary>Расшифровка (${(r.transcript || []).length})</summary>${tr}</details></section>`;
  }).join("");
  res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Звонки</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:0 auto;padding:16px;background:#f1f5f9;color:#0f172a}section,.mem{background:#fff;border-radius:14px;padding:14px 18px;margin:14px 0;box-shadow:0 2px 8px rgba(0,0,0,.06)}h2{font-size:18px;margin:0 0 6px}h3{font-size:15px;margin:12px 0 4px}.t{font-size:14px;margin:3px 0}.t.child b{color:#db2777}.t.char b{color:#1d4ed8}.t.fn,.t.note{color:#64748b;font-size:12px}pre{white-space:pre-wrap;font-size:13px}</style></head><body>
<h1>📞 Звонки дочки</h1><p>Время ${esc(TZ_LABEL)}. Хранилище: ${esc(memory.mode())}. Кадры с камеры не сохраняются.</p>
<div class="mem"><h3>🧠 Что персонаж вспомнит в следующем звонке</h3><pre>${esc(mem || "(пока ничего)")}</pre></div>${cards || "<p>Звонков пока нет.</p>"}</body></html>`);
});

app.post("/parent/delete", express.urlencoded({ extended: false }), async (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (!keyOk(req.query.key)) return res.status(404).send("Not found");
  try { await memory.del(req.body.id); } catch (e) { return res.status(500).send("error"); }
  res.redirect(303, "/parent?key=" + encodeURIComponent(req.query.key));
});

memory.init().then((m) => console.log("memory:", m), (e) => console.error("memory init failed:", e.message))
  .finally(() => server.listen(PORT, () => console.log("sheriff-call on", PORT, CHILD_CONTEXT ? "(child context set)" : "(no child context)")));
