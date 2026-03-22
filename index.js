const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const express = require("express");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.use(express.json());

// Store OTP codes: { phone: { code, expiresAt } }
const otpStore = {};

let sock = null;

// ─── Start WhatsApp Connection ───────────────────────────────────────────────
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // We use pairing code instead
  });

  // Save credentials whenever updated
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Request pairing code on first launch
    if (!sock.authState.creds.registered) {
      const phoneNumber = process.env.WA_PHONE_NUMBER;
      if (!phoneNumber) {
        console.log("❌ ERROR: Set WA_PHONE_NUMBER in your .env file!");
        return;
      }
      console.log("📱 Requesting pairing code for:", phoneNumber);
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log("==================================");
        console.log("🔑 YOUR PAIRING CODE:", code);
        console.log("==================================");
        console.log("👉 Open WhatsApp → Linked Devices → Link with phone number");
        console.log("👉 Enter the code above");
      } catch (err) {
        console.error("Failed to get pairing code:", err.message);
      }
    }

    if (connection === "close") {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("🔌 Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) startWhatsApp();
    } else if (connection === "open") {
      console.log("✅ WhatsApp connected! Bot is ready.");
    }
  });
}

// ─── Generate OTP ─────────────────────────────────────────────────────────────
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

// ─── API Key Middleware ───────────────────────────────────────────────────────
function checkApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

// ─── POST /send-otp ───────────────────────────────────────────────────────────
app.post("/send-otp", checkApiKey, async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, message: "Phone number is required" });
  }

  // Format phone: remove + and spaces, e.g. +263784868165 → 263784868165
  const formattedPhone = phone.replace(/\D/g, "") + "@s.whatsapp.net";

  const otp = generateOTP();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  // Save OTP
  otpStore[phone] = { code: otp, expiresAt };

  try {
    await sock.sendMessage(formattedPhone, {
      text: `🔐 Your *ChatterApp* verification code is:\n\n*${otp}*\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
    });

    console.log(`✅ OTP sent to ${phone}: ${otp}`);
    res.json({ success: true, message: "OTP sent successfully" });
  } catch (err) {
    console.error("Failed to send OTP:", err.message);
    res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
});

// ─── POST /verify-otp ─────────────────────────────────────────────────────────
app.post("/verify-otp", checkApiKey, (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ success: false, message: "Phone and code are required" });
  }

  const record = otpStore[phone];

  if (!record) {
    return res.status(400).json({ success: false, message: "No OTP found for this number" });
  }

  if (Date.now() > record.expiresAt) {
    delete otpStore[phone];
    return res.status(400).json({ success: false, message: "OTP has expired" });
  }

  if (record.code !== code) {
    return res.status(400).json({ success: false, message: "Incorrect OTP" });
  }

  // OTP is valid — delete it so it can't be reused
  delete otpStore[phone];
  console.log(`✅ OTP verified for ${phone}`);
  res.json({ success: true, message: "Phone number verified successfully" });
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/ping", (req, res) => res.send("Bot is alive! 🤖"));

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  startWhatsApp();
});
