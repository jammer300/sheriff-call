const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
const KEY = process.env.LLM_API_KEY || process.env.XAI_API_KEY;
const PORT = process.env.PORT || 8787;
const VOICE = process.env.SHERIFF_VOICE || "rex";
const MODEL = process.env.SHERIFF_MODEL || "grok-voice-latest";
const persona = fs.readFileSync(path.join(__dirname, "persona.md"), "utf8");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// simple abuse guard: limit token minting (public tunnel URL)
const hits = [];
function allowed() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 3600e3) hits.shift();
  if (hits.length >= 60) return false;
  hits.push(now); return true;
}

app.post("/api/session", async (req, res) => {
  if (!allowed()) return res.status(429).json({ error: "too many calls, try later" });
  try {
    const r = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { seconds: 300 }, session: { model: MODEL, reasoning: { effort: "none" } } }),
    });
    const j = await r.json();
    if (!r.ok || !j.value) { console.error("mint failed", r.status, j); return res.status(502).json({ error: "mint failed" }); }
    const voice = (req.body && /^[a-z0-9_-]{2,40}$/i.test(req.body.voice || "")) ? req.body.voice : VOICE;
    console.log(new Date().toISOString(), "session minted, voice", voice);
    res.json({
      token: j.value, expires_at: j.expires_at, model: MODEL,
      session: {
        voice,
        instructions: persona,
        turn_detection: { type: "server_vad", idle_timeout_ms: 25000 },
        audio: {
          input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { language_hint: "ru" } },
          output: { format: { type: "audio/pcm", rate: 24000 } },
        },
      },
    });
  } catch (e) { console.error(e); res.status(500).json({ error: String(e) }); }
});
app.post("/api/log", (req, res) => { console.log("client:", JSON.stringify(req.body).slice(0, 500)); res.json({ ok: 1 }); });
app.get("/healthz", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log("sheriff-call on", PORT));
