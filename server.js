const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const APP_NAME = "ms";
const BOT_TOKEN = process.env.BOT_TOKEN || "9024683860:AAGwu0-b8TTrq2gMC4ZCaZoDsRXBN1ibRZs";
const ADMIN_ID = process.env.ADMIN_ID || "7476086614";
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : "";

// In-memory storage for demonstration / Vercel compatibility (Replace with DB like MongoDB/PostgreSQL for production)
let users = {}; // device_id -> { status, expires_at, access_token_hash, created_at, updated_at }
let signals = []; // list of signal objects
let announcements = []; // list of announcements
let cooldowns = {}; // device_id -> next_allowed_at timestamp

const DEMO_PAIRS = [
  "USD/BRL OTC", "USD/MXN OTC", "USD/COP OTC", "USD/PKR OTC", 
  "USD/INR OTC", "USD/IDR OTC", "USD/PHP OTC", "EUR/USD OTC", 
  "GBP/USD OTC", "USD/JPY OTC", "AUD/USD OTC", "NZD/USD OTC"
];

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function validDeviceId(deviceId) {
  return typeof deviceId === 'string' && /^[A-F0-9]{24}$/.test(deviceId);
}

// Telegram helper
async function tgCall(method, payload = {}) {
  if (!BOT_TOKEN) return null;
  try {
    const fetch = (await import('node-fetch')).default;
    const r = await fetch(`${TELEGRAM_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await r.json();
  } catch (err) {
    console.error("Telegram API error:", err);
    return null;
  }
}

async function adminMessage(text, replyMarkup = null) {
  if (!ADMIN_ID || !BOT_TOKEN) return;
  const payload = { chat_id: ADMIN_ID, text: text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await tgCall("sendMessage", payload);
}

async function notifyNewUser(deviceId) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "Approve 7 days", callback_data: `approve|${deviceId}|7d` },
        { text: "Approve 30 days", callback_data: `approve|${deviceId}|30d` }
      ],
      [
        { text: "Block user", callback_data: `block|${deviceId}` }
      ]
    ]
  };
  await adminMessage(
    `New TRADER SANA demo user\nDevice ID: ${deviceId}\nStatus: PENDING\n\nFor custom expiry use:\n/approve DEVICE_ID YYYY-MM-DD HH:MM\nTime is UTC.`,
    keyboard
  );
}

// Routes
app.post("/api/register", (req, res) => {
  const { deviceId } = req.body || {};
  if (!validDeviceId(deviceId)) {
    return res.status(400).json({ error: "Invalid installation ID" });
  }

  let isNew = false;
  if (!users[deviceId]) {
    users[deviceId] = {
      device_id: deviceId,
      status: 'pending',
      expires_at: null,
      access_token_hash: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    isNew = true;
  }

  if (isNew) {
    notifyNewUser(deviceId);
  }

  res.json({ registered: true, status: users[deviceId].status });
});

app.post("/api/status", (req, res) => {
  const { deviceId } = req.body || {};
  if (!validDeviceId(deviceId)) {
    return res.status(400).json({ error: "Invalid installation ID" });
  }

  let user = users[deviceId];
  let state = user ? user.status : "not_registered";

  if (user && user.status === 'approved' && user.expires_at) {
    if (new Date(user.expires_at) <= new Date()) {
      state = "expired";
    }
  }

  let response = { status: state, expiresAt: user ? user.expires_at : null };

  if (state === "approved") {
    let token = req.headers["x-access-token"];
    if (!token || hashToken(token) !== user.access_token_hash) {
      token = crypto.randomBytes(24).toString('hex');
      user.access_token_hash = hashToken(token);
      user.updated_at = new Date().toISOString();
    }
    response.accessToken = token;
  }

  res.json(response);
});

app.post("/api/signals", (req, res) => {
  const token = req.body.accessToken;
  if (!token) return res.status(403).json({ error: "Access denied or expired" });

  const tokenHash = hashToken(token);
  const user = Object.values(users).find(u => u.access_token_hash === tokenHash && u.status === 'approved');

  if (!user) return res.status(403).json({ error: "Access denied or expired" });

  const current = signals.length > 0 ? signals[signals.length - 1] : null;
  const history = [...signals].reverse().slice(0, 10);

  res.json({ current, history });
});

// Telegram Webhook endpoint for Admin commands
app.post("/api/telegram-webhook", async (req, res) => {
  const update = req.body;
  if (!update) return res.sendStatus(200);

  const message = update.message;
  const callbackQuery = update.callback_query;

  if (message) {
    const chatId = message.chat.id;
    const text = message.text ? message.text.trim() : "";
    if (ADMIN_ID && String(message.from.id) === ADMIN_ID) {
      if (text.startsWith("/start") || text.startsWith("/help")) {
        await tgCall("sendMessage", {
          chat_id: chatId,
          text: "TRADER SANA ADMIN COMMANDS\n\n/users - List users\n/stats - Show stats"
        });
      } else if (text.startsWith("/users")) {
        const userList = Object.values(users).map(u => `${u.device_id} | ${u.status} | ${u.expires_at || 'No expiry'}`).join('\n');
        await tgCall("sendMessage", { chat_id: chatId, text: userList || "No users yet." });
      }
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
