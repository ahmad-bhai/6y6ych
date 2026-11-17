const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const APP_NAME = "MS BOT";
const BOT_TOKEN = process.env.BOT_TOKEN || "9024683860:AAGwu0-b8TTrq2gMC4ZCaZoDsRXBN1ibRZs";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// In-memory storage (For production, connect MongoDB/PostgreSQL)
let users = {}; // device_id -> user object
let signals = []; 
let announcements = [];
let dynamicAdminId = null; // Jo pehli baar /start karega woh admin ban jayega

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function validDeviceId(deviceId) {
  return typeof deviceId === 'string' && /^[A-F0-9]{24}$/.test(deviceId);
}

async function tgCall(method, payload = {}) {
  if (!BOT_TOKEN || BOT_TOKEN.includes("FAKE_TOKEN")) return null;
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
  if (!dynamicAdminId) return;
  const payload = { chat_id: dynamicAdminId, text: text };
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
    `New ${APP_NAME} user\nDevice ID: ${deviceId}\nStatus: PENDING`,
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

// Telegram Webhook Endpoint
app.post("/api/telegram-webhook", async (req, res) => {
  const update = req.body;
  if (!update) return res.sendStatus(200);

  const message = update.message;
  const callbackQuery = update.callback_query;

  if (message) {
    const chatId = message.chat.id;
    const text = message.text ? message.text.trim() : "";

    // Dynamic Admin Assignment: Pehla user jo message karega woh Admin ban jayega
    if (!dynamicAdminId) {
      dynamicAdminId = String(chatId);
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: `Aapko kamyabi ke sath ${APP_NAME} ka Admin bana diya gaya hai! 🎉`
      });
    }

    if (String(chatId) === dynamicAdminId) {
      if (text.startsWith("/start") || text.startsWith("/help")) {
        await tgCall("sendMessage", {
          chat_id: chatId,
          text: `${APP_NAME} ADMIN COMMANDS\n\n/users - List all users\n/stats - Show platform stats`
        });
      } else if (text.startsWith("/users")) {
        const userList = Object.values(users)
          .map(u => `${u.device_id} | ${u.status} | ${u.expires_at || 'No expiry'}`)
          .join('\n');
        await tgCall("sendMessage", { chat_id: chatId, text: userList || "No users registered yet." });
      } else if (text.startsWith("/stats")) {
        const total = Object.keys(users).length;
        const pending = Object.values(users).filter(u => u.status === 'pending').length;
        const approved = Object.values(users).filter(u => u.status === 'approved').length;
        await tgCall("sendMessage", { chat_id: chatId, text: `STATS:\nTotal: ${total}\nPending: ${pending}\nApproved: ${approved}` });
      }
    }
  }

  if (callbackQuery) {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    const parts = data.split("|");

    if (String(chatId) === dynamicAdminId && parts.length === 3 && parts[0] === "approve") {
      const deviceId = parts[1];
      const days = parts[2] === "7d" ? 7 : 30;
      const expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      
      if (users[deviceId]) {
        users[deviceId].status = 'approved';
        users[deviceId].expires_at = expiry;
        await tgCall("answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "User approved!" });
        await tgCall("sendMessage", { chat_id: chatId, text: `User ${deviceId} approved for ${days} days.` });
      }
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`${APP_NAME} server running on port ${PORT}`);
});
