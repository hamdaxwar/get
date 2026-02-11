const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ================= KONFIGURASI =================
const BOT_TOKEN = "8355352388:AAFjePLqG9D4v88GSNk18brV_lAtVVEaucE";
const CHAT_ID = "-1003492226491"; 
const TELEGRAM_BOT_LINK = "https://t.me/newgettbot";
const TELEGRAM_ADMIN_LINK = "https://t.me/Imr1d";

// API CONFIG
const API_URL = "https://x.mnitnetwork.com/mapi/v1/public/numsuccess/info";
const API_KEY = "M_W17E9N1DD";

const SMC_JSON_FILE = path.join(__dirname, "smc.json");
const CACHE_FILE = path.join(__dirname, 'otp_cache.json');

let COUNTRY_EMOJI = {};
try {
    COUNTRY_EMOJI = require('./country.json');
} catch (e) {
    COUNTRY_EMOJI = {};
}

// ================= UTILS =================

function escapeHtml(text) {
    if (!text) return "";
    return text.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function getCountryEmoji(country) {
    return COUNTRY_EMOJI[country?.trim().toUpperCase()] || "🏳️";
}

function getCache() {
    if (fs.existsSync(CACHE_FILE)) {
        try { return JSON.parse(fs.readFileSync(CACHE_FILE)); } catch (e) { return {}; }
    }
    return {};
}

function saveToCache(cache) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function extractOtp(text) {
    if (!text) return null;
    const patterns = [
        /(\d{4,8})/, 
        /(?:code|otp|kode)[:\s]*([\d\s-]+)/i
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m) {
            const otp = (m[1] || m[0]).replace(/[^\d]/g, '');
            if (otp) return otp;
        }
    }
    return null;
}

// Logika Deteksi Service berdasarkan Kata Kunci di Pesan
function detectService(message) {
    if (!message) return "<i>not detected</i>";
    const msg = message.toLowerCase();
    if (msg.includes("facebook") || msg.includes("fb")) return "Facebook";
    if (msg.includes("whatsapp") || msg.includes("wa")) return "WhatsApp";
    if (msg.includes("telegram") || msg.includes("tg")) return "Telegram";
    if (msg.includes("google") || msg.includes("g-")) return "Google";
    if (msg.includes("tiktok")) return "TikTok";
    return "<i>not detected</i>";
}

function maskPhone(phone) {
    if (!phone) return "N/A";
    const digits = phone.replace(/[^\d]/g, '');
    if (digits.length < 7) return phone;
    return `+${digits.slice(0, 5)}***${digits.slice(-4)}`;
}

async function sendTelegram(text, otpCode, targetChat = CHAT_ID) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
        chat_id: targetChat,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: otpCode, copy_text: { text: otpCode } }, 
                    { text: "🎭 Owner", url: TELEGRAM_ADMIN_LINK }
                ],
                [{ text: "📞 Get Number", url: TELEGRAM_BOT_LINK }]
            ]
        }
    };

    try {
        await axios.post(url, payload);
        console.log(`✅ [SUCCESS] Telegram terkirim (OTP: ${otpCode})`);
    } catch (e) {
        console.error(`❌ [TG ERROR] Gagal kirim pesan.`);
    }
}

// ================= API MONITORING LOGIC =================

async function startApiMonitor() {
    console.log("🚀 [SYSTEM] Monitoring API aktif...");

    while (true) {
        try {
            const response = await axios.get(API_URL, {
                headers: { 'mapikey': API_KEY, 'User-Agent': 'Mozilla/5.0' },
                timeout: 10000 
            });

            if (response.data && response.data.data && Array.isArray(response.data.data.otps)) {
                const otps = response.data.data.otps;
                const cache = getCache();
                let isCacheUpdated = false;

                for (const item of otps) {
                    const uniqueId = item.nid; // Tetap pakai NID untuk cek duplikat di cache
                    const fullMessage = item.otp || ""; 
                    const otpCode = extractOtp(fullMessage);
                    let phone = item.number ? item.number.toString() : "";
                    if (phone && !phone.startsWith('+')) phone = "+" + phone;

                    if (otpCode && !cache[uniqueId]) {
                        cache[uniqueId] = { t: new Date().toISOString() };
                        isCacheUpdated = true;

                        const serviceName = detectService(fullMessage);
                        const emoji = getCountryEmoji(item.country || "");

                        // Format pesan Telegram (ID dihapus sesuai permintaan)
                        const msg = `💭 <b>New Message Received</b>\n\n` +
                                    `<b>☎️ Number:</b> <code>${maskPhone(phone)}</code>\n` +
                                    `<b>🌍 Country:</b> <b>${escapeHtml(item.country || "Unknown")} ${emoji}</b>\n` +
                                    `<b>⚙️ Service:</b> <b>${serviceName}</b>\n\n` +
                                    `🔐 OTP: <code>${otpCode}</code>\n\n` +
                                    `<b>FULL MESSAGE:</b>\n` +
                                    `<blockquote>${escapeHtml(fullMessage)}</blockquote>`;
                        
                        await sendTelegram(msg, otpCode);

                        // Simpan log ke JSON
                        let existingLog = [];
                        if (fs.existsSync(SMC_JSON_FILE)) {
                            try { existingLog = JSON.parse(fs.readFileSync(SMC_JSON_FILE)); } catch(e){}
                        }
                        existingLog.push({
                            service: serviceName.replace(/<\/?[^>]+(>|$)/g, ""), // Bersihkan tag HTML untuk JSON
                            number: phone,
                            otp: otpCode,
                            full_message: fullMessage,
                            timestamp: new Date().toLocaleString()
                        });
                        fs.writeFileSync(SMC_JSON_FILE, JSON.stringify(existingLog.slice(-50), null, 2));

                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
                if (isCacheUpdated) saveToCache(cache);
            }
        } catch (e) {
            console.error(`❌ [ERROR] ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 4000));
    }
}

startApiMonitor();
