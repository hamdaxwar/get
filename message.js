const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ================= KONFIGURASI =================
const BOT_TOKEN = "8355352388:AAFjePLqG9D4v88GSNk18brV_lAtVVEaucE";
const CHAT_ID = "-1003492226491"; 
const ADMIN_ID = "7184123643";
const TELEGRAM_BOT_LINK = "https://t.me/newgettbot";
const TELEGRAM_ADMIN_LINK = "https://t.me/Imr1d";

// API CONFIG
const API_URL = "https://x.mnitnetwork.com/mapi/v1/public/numsuccess/info";
const API_KEY = "M_W17E9N1DD";

const SMC_JSON_FILE = path.join(__dirname, "smc.json");
const CACHE_FILE = path.join(__dirname, 'otp_cache.json');

// Pastikan file country.json ada, kalau tidak ada kita buat fallback
let COUNTRY_EMOJI = {};
try {
    COUNTRY_EMOJI = require('./country.json');
} catch (e) {
    console.warn("⚠️ [WARN] country.json tidak ditemukan, menggunakan fallback emoji.");
}

let totalSent = 0;

// ================= UTILS =================

function escapeHtml(text) {
    if (!text) return "";
    return text
        .toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function getCountryEmoji(country) {
    return COUNTRY_EMOJI[country?.trim().toUpperCase()] || "🏴‍☠️";
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
        /(\d{3}[\s-]\d{3})/, 
        /(?:code|otp|kode)[:\s]*([\d\s-]+)/i,
        /\b(\d{4,8})\b/
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

function maskPhone(phone) {
    if (!phone || phone === "N/A") return phone;
    const digits = phone.replace(/[^\d]/g, '');
    if (digits.length < 7) return phone;
    const prefix = phone.startsWith('+') ? '+' : '';
    return `${prefix}${digits.slice(0, 5)}***${digits.slice(-4)}`;
}

async function sendTelegram(text, otpCode = null, targetChat = CHAT_ID) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
        chat_id: targetChat,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    };

    if (otpCode) {
        payload.reply_markup = {
            inline_keyboard: [
                [
                    { text: `📋 Copy OTP: ${otpCode}`, callback_data: `copy_${otpCode}` }, 
                    { text: "🎭 Owner", url: TELEGRAM_ADMIN_LINK }
                ],
                [{ text: "📞 Get Number", url: TELEGRAM_BOT_LINK }]
            ]
        };
    }

    try {
        await axios.post(url, payload);
        console.log(`✅ [SUCCESS] Telegram terkirim (OTP: ${otpCode})`);
    } catch (e) {
        console.error(`❌ [TG ERROR] Gagal kirim pesan ke Telegram.`);
    }
}

// ================= API MONITORING LOGIC =================

async function startApiMonitor() {
    console.log("🚀 [SYSTEM] Monitoring API aktif (Interval: 4 detik)...");

    while (true) {
        try {
            const response = await axios.get(API_URL, {
                headers: {
                    'mapikey': API_KEY,
                    'Accept': 'application/json, text/plain, */*',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://x.mnitnetwork.com/'
                },
                timeout: 15000 
            });

            if (response.data && response.data.data && Array.isArray(response.data.data.otps)) {
                const otps = response.data.data.otps;
                const cache = getCache();
                let isCacheUpdated = false;

                for (const item of otps) {
                    let phone = item.number ? item.number.toString() : "";
                    if (phone && !phone.startsWith('+')) phone = "+" + phone;

                    const fullMessage = item.otp || ""; 
                    const otpCode = extractOtp(fullMessage);
                    const uniqueId = item.nid || `${otpCode}_${phone}`;
                    
                    if (otpCode && !cache[uniqueId]) {
                        cache[uniqueId] = { t: new Date().toISOString() };
                        isCacheUpdated = true;

                        // Log ke smc.json
                        const entry = {
                            service: item.operator || "Unknown",
                            number: phone,
                            otp: otpCode,
                            full_message: fullMessage,
                            nid: item.nid,
                            timestamp: item.created_at || new Date().toLocaleString()
                        };

                        let existingLog = [];
                        if (fs.existsSync(SMC_JSON_FILE)) {
                            try { existingLog = JSON.parse(fs.readFileSync(SMC_JSON_FILE)); } catch(e){}
                        }
                        existingLog.push(entry);
                        fs.writeFileSync(SMC_JSON_FILE, JSON.stringify(existingLog.slice(-100), null, 2));

                        // Kirim Telegram
                        const emoji = getCountryEmoji(item.country || "");
                        const msg = `💭 <b>New Message Received</b>\n\n` +
                                    `<b>☎️ Number:</b> <code>${maskPhone(phone)}</code>\n` +
                                    `<b>🌍 Country:</b> <b>${escapeHtml(item.country || "Unknown")} ${emoji}</b>\n` +
                                    `<b>⚙️ Service:</b> <b>${escapeHtml(item.operator || "Service")}</b>\n\n` +
                                    `🔐 OTP: <code>${otpCode}</code>\n\n` +
                                    `<b>FULL MESSAGE:</b>\n` +
                                    `<blockquote>${escapeHtml(fullMessage)}</blockquote>\n` +
                                    `<code>ID: ${item.nid}</code>`;
                        
                        await sendTelegram(msg, otpCode);
                        totalSent++;
                        await new Promise(r => setTimeout(r, 1000)); // Delay antar pesan TG
                    }
                }

                if (isCacheUpdated) saveToCache(cache);
            }

        } catch (e) {
            if (e.response) {
                if (e.response.status === 403) {
                    console.error("❌ [403] Terdeteksi Cloudflare! Jeda otomatis 30 detik...");
                    await new Promise(r => setTimeout(r, 30000));
                } else {
                    const errorMsg = typeof e.response.data === 'string' ? "HTML Block" : "JSON Error";
                    console.error(`❌ [API ERROR] Status: ${e.response.status} (${errorMsg})`);
                }
            } else {
                console.error(`❌ [API ERROR] Network/Timeout: ${e.message}`);
            }
        }

        // Delay loop utama: 4 Detik
        await new Promise(r => setTimeout(r, 4000));
    }
}

startApiMonitor();
