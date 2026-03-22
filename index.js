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
    printQRInTerminal: false,
    browser: ["ChatterApp", "Chrome", "1.0.0"],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
  });

  // Save credentials whenever updated
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    // Request pairing code on first launch
    if (!sock.authState.creds.registered) {
      const phoneNumber = process.env.WA_PHONE_NUMBER;
      if (!phoneNumber) {
        console.log("❌ ERROR: Set WA_PHONE_NUMBER in your environment variables!");
        return;
      }

      // Wait 3 seconds for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 3000));

      console.log("📱 Requesting pairing code for:", phoneNumber);
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log("==================================");
        console.log("🔑 YOUR PAIRING CODE:", code);
        console.log("==================================");
        console.log("👉 Open WhatsApp → Linked Devices → Link with phone number");
        console.log("👉 Enter the code above within 60 seconds!");
      } catch (err) {
        console.error("❌ Failed to get pairing code:", err.message);
        console.log("🔄 Retrying in 5 seconds...");
        setTimeout(() => startWhatsApp(), 5000);
      }
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("🔌 Connection closed. Status:", statusCode, "Reconnecting:", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(), 3000);
      } else {
        console.log("⚠️ Logged out! Please restart and re-link your number.");
      }
    } else if (connection === "open") {
      console.log("✅ WhatsApp connected! ChatterApp bot is ready to send OTPs.");
    } else if (connection === "connecting") {
      console.log("🔄 Connecting to WhatsApp...");
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

  if (!sock) {
    return res.status(503).json({ success: false, message: "WhatsApp not connected yet" });
  }

  // Format phone: remove all non-digits, add @s.whatsapp.net
  const formattedPhone = phone.replace(/\D/g, "") + "@s.whatsapp.net";

  const otp = generateOTP();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  // Save OTP
  otpStore[phone] = { code: otp, expiresAt };

  try {
    await sock.sendMessage(formattedPhone, {
      text: `🔐 Your *ChatterApp* verification code is:\n\n*${otp}*\n\nThis code expires in 10 minutes.\nDo not share it with anyone.`,
    });

    console.log(`✅ OTP sent to ${phone}`);
    res.json({ success: true, message: "OTP sent successfully" });
  } catch (err) {
    console.error("❌ Failed to send OTP:", err.message);
    res.status(500).json({ success: false, message: "Failed to send OTP. Make sure WhatsApp is linked." });
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
    return res.status(400).json({ success: false, message: "No OTP found for this number. Please request a new one." });
  }

  if (Date.now() > record.expiresAt) {
    delete otpStore[phone];
    return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
  }

  if (record.code !== code) {
    return res.status(400).json({ success: false, message: "Incorrect OTP. Please try again." });
  }

  // OTP is valid — delete it so it can't be reused
  delete otpStore[phone];
  console.log(`✅ OTP verified for ${phone}`);
  res.json({ success: true, message: "Phone number verified successfully! ✅" });
});

// ─── Health Check (used by UptimeRobot to keep bot alive) ────────────────────
app.get("/ping", (req, res) => {
  res.json({ status: "alive", message: "ChatterApp OTP Bot is running! 🤖" });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ChatterApp OTP Bot running on port ${PORT}`);
  startWhatsApp();
});
              
