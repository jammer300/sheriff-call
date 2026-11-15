// Function tools the voice model can call. Visual ones are executed in the browser
// (it draws the game card and returns a function_call_output); look_at_camera is completed
// on the server (vision model) after the browser sends one webcam frame.
const COLORS = ["красный", "оранжевый", "жёлтый", "зелёный", "голубой", "синий", "фиолетовый", "розовый", "белый", "чёрный", "коричневый"];
const ROOMS = ["office", "garage", "playroom", "kitchen"];
const TOOLS = [
  { type: "function", name: "show_count", description: "Game «Счёт»: show N identical objects big on the screen so the girl can count them. Then ask «Сколько?» and wait.",
    parameters: { type: "object", properties: { emoji: { type: "string", description: "ONE emoji of the object, e.g. 🍎 ⭐ 🐶 🚓 🎈 🦋" }, count: { type: "integer", minimum: 1, maximum: 10 } }, required: ["emoji", "count"] } },
  { type: "function", name: "show_letter", description: "Game «Буквы»: show one big Russian letter with a picture of a word that starts with it (А — арбуз 🍉).",
    parameters: { type: "object", properties: { letter: { type: "string", description: "one Russian capital letter" }, word: { type: "string", description: "Russian word starting with the letter" }, emoji: { type: "string", description: "ONE emoji picturing the word" } }, required: ["letter", "word", "emoji"] } },
  { type: "function", name: "show_picture", description: "Game «Слова» (and pictures for stories): show one big picture. In the Words game ask «Что это?»; the English word is shown small.",
    parameters: { type: "object", properties: { emoji: { type: "string", description: "ONE emoji, e.g. 🐘 🍌 🚁 🐱" }, ru: { type: "string", description: "Russian word" }, en: { type: "string", description: "English word (optional)" } }, required: ["emoji", "ru"] } },
  { type: "function", name: "show_high_five", description: "Game «Дай пять!»: a big paw appears on the screen. Ask her to tap it. You will get a note when she taps it.",
    parameters: { type: "object", properties: {} } },
  { type: "function", name: "show_colors", description: "Game «Цвета»: show 2–4 big colored circles. Ask her to tap a color (e.g. «Нажми на красный!»). You will get a note which color she tapped.",
    parameters: { type: "object", properties: { colors: { type: "array", items: { type: "string", enum: COLORS }, minItems: 2, maxItems: 4 } }, required: ["colors"] } },
  { type: "function", name: "celebrate", description: "Confetti, stars and a happy sound on the screen. Use after a correct answer, a finished game or the happy end of an adventure.",
    parameters: { type: "object", properties: {} } },
  { type: "function", name: "clear_screen", description: "Remove the game card from the screen (game over or changing topic).",
    parameters: { type: "object", properties: {} } },
  { type: "function", name: "go_to_room", description: "Walk with the girl to another room of the police station: office (кабинет, your desk), garage (гараж: police car and Papillon's helicopter), playroom (игровая: toys, games), kitchen (кухня: snacks, talking about food). Call it when you or she suggests going somewhere.",
    parameters: { type: "object", properties: { room: { type: "string", enum: ROOMS } }, required: ["room"] } },
  { type: "function", name: "look_at_camera", description: "Look through the video camera to SEE what the girl is showing you. Call it whenever she says «смотри», «вот», «покажу», «посмотри», «look», or asks what you see. Returns a short description of what is in front of the camera.",
    parameters: { type: "object", properties: {} } },
];
const NAMES = { sheriff: "Шериф", papillon: "Папийон", dobie: "Доби" };
// group call: friends join the call and speak in their own voice (text-to-speech), the lead directs them
function toolsFor(lead) {
  const friends = Object.keys(NAMES).filter((k) => k !== lead);
  return TOOLS.concat([
    { type: "function", name: "invite_friend", description: `Call a friend from the police station into this video call (${friends.map((f) => f + " = " + NAMES[f]).join(", ")}). Use when she asks for them («позови Доби»), or to make a story or game more fun. Max 2 friends.`,
      parameters: { type: "object", properties: { who: { type: "string", enum: friends } }, required: ["who"] } },
    { type: "function", name: "friend_says", description: "Make a friend who is in the call say something in THEIR OWN voice. Everything a friend says MUST go through this tool; never speak a friend's words in your own voice.",
      parameters: { type: "object", properties: { who: { type: "string", enum: friends }, text: { type: "string", description: "What the friend says: Russian, 1–2 short sentences, in their own personality and correct grammatical gender." } }, required: ["who", "text"] } },
    { type: "function", name: "friend_leaves", description: "A friend says bye and leaves the call (when she asks, or the friend has to go on duty).",
      parameters: { type: "object", properties: { who: { type: "string", enum: friends } }, required: ["who"] } },
  ]);
}
module.exports = { TOOLS, COLORS, ROOMS, NAMES, toolsFor };
