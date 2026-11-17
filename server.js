const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const APP_NAME = "MS BOT";
const BOT_TOKEN = process.env.BOT_TOKEN || "9024683860:AAGwu0-b8TTrq2gMC4ZCaZoDsRXBN1ibRZs";
const ADMIN_ID = "7476086614"; // Aapki fix Admin ID
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const FIREBASE_URL = "https://reactions-maker-site-default-rtdb.firebaseio.com/ms-bot";

app.get("/health", (req, res) => {
  res.json({ ok: true, app: APP_NAME });
});

async function fetchFirebase(endpoint = "") {
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`${FIREBASE_URL}/${endpoint}.json`);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("Firebase read error:", err);
    return null;
  }
}

async function saveFirebase(endpoint, data) {
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`${FIREBASE_URL}/${endpoint}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await res.json();
  } catch (err) {
    console.error("Firebase write error:", err);
    return null;
  }
}

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
    console.error("Telegram API call error:", err);
    return null;
  }
}

async function adminMessage(text, replyMarkup = null) {
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
    `New ${APP_NAME} user\nDevice ID: ${deviceId}\nStatus: PENDING`,
    keyboard
  );
}

app.post("/api/register", async (req, res) => {
  const { deviceId } = req.body || {};
  if (!validDeviceId(deviceId)) {
    return res.status(400).json({ error: "Invalid installation ID" });
  }

  let dbData = await fetchFirebase() || {};
  let users = dbData.users || {};

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
    await saveFirebase("users", users);
  }

  if (isNew) {
    await notifyNewUser(deviceId);
  }

  res.json({ registered: true, status: users[deviceId].status });
});

app.post("/api/status", async (req, res) => {
  const { deviceId } = req.body || {};
  if (!validDeviceId(deviceId)) {
    return res.status(400).json({ error: "Invalid installation ID" });
  }

  let dbData = await fetchFirebase() || {};
  let users = dbData.users || {};
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
      users[deviceId] = user;
      await saveFirebase("users", users);
    }
    response.accessToken = token;
  }

  res.json(response);
});

app.post("/api/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;
    if (!update) return res.sendStatus(200);

    const message = update.message;
    const callbackQuery = update.callback_query;

    if (message) {
      const chatId = String(message.chat.id);
      const text = message.text ? message.text.trim() : "";

      // Debugging ke liye: Har user ko uska ID bata dega
      if (text.startsWith("/start") || text.startsWith("/help")) {
        if (chatId === String(ADMIN_ID)) {
          await tgCall("sendMessage", {
            chat_id: chatId,
            text: `${APP_NAME} ADMIN PANEL\n\nAapka ID match ho gaya hai!\n\n/users - List all users\n/stats - Show platform stats`
          });
        } else {
          await tgCall("sendMessage", {
            chat_id: chatId,
            text: `Aapka Telegram Chat ID yeh hai: ${chatId}\nLekin aap Admin nahi hain.`
          });
        }
      } else if (chatId === String(ADMIN_ID)) {
        if (text.startsWith("/users")) {
          const dbData = await fetchFirebase() || {};
          const users = dbData.users || {};
          const userList = Object.values(users)
            .map(u => `${u.device_id} | ${u.status} | ${u.expires_at || 'No expiry'}`)
            .join('\n');
          await tgCall("sendMessage", { chat_id: chatId, text: userList || "No users registered yet." });
        } else if (text.startsWith("/stats")) {
          const dbData = await fetchFirebase() || {};
          const users = dbData.users || {};
          const total = Object.keys(users).length;
          const pending = Object.values(users).filter(u => u.status === 'pending').length;
          const approved = Object.values(users).filter(u => u.status === 'approved').length;
          await tgCall("sendMessage", { chat_id: chatId, text: `STATS:\nTotal: ${total}\nPending: ${pending}\nApproved: ${approved}` });
        }
      }
    }

    if (callbackQuery) {
      const data = callbackQuery.data;
      const chatId = String(callbackQuery.message.chat.id);
      const parts = data.split("|");

      if (chatId === String(ADMIN_ID) && parts.length === 3 && parts[0] === "approve") {
        const deviceId = parts[1];
        const days = parts[2] === "7d" ? 7 : 30;
        const expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
        
        let dbData = await fetchFirebase() || {};
        let users = dbData.users || {};
        if (users[deviceId]) {
          users[deviceId].status = 'approved';
          users[deviceId].expires_at = expiry; // <-- Fix here (dot instead of comma)
          await saveFirebase("users", users);

          await tgCall("answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "User approved!" });
          await tgCall("sendMessage", { chat_id: chatId, text: `User ${deviceId} approved for ${days} days.` });
        }
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`${APP_NAME} server running on port ${PORT}`);
});
