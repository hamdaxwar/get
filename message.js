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
const COUNTRY_EMOJI = require('./country.json');

let totalSent = 0;

// ================= UTILS =================

function escapeHtml(text) {
    if (!text) return "";
    return text
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
                    { text: ` ${otpCode}`, copy_text: { text: otpCode } }, 
                    { text: "🎭 Owner", url: TELEGRAM_ADMIN_LINK }
                ],
                [{ text: "📞 Get Number", url: TELEGRAM_BOT_LINK }]
            ]
        };
    }

    try {
        const res = await axios.post(url, payload);
        if (res.data.ok) {
            console.log(`✅ [SUCCESS] Telegram terkirim ke ${targetChat} (OTP: ${otpCode})`);
        }
    } catch (e) {
        if (e.response && e.response.data) {
            console.error(`❌ [TG ERROR] API Menolak:`, JSON.stringify(e.response.data));
        } else {
            console.error(`❌ [TG ERROR] Koneksi: ${e.message}`);
        }
    }
}

// ================= API MONITORING LOGIC =================

async function startApiMonitor() {
    console.log("🚀 [SYSTEM] Monitoring API dimulai...");
    console.log(`🔗 Endpoint: ${API_URL}`);

    // Loop tanpa henti
    while (true) {
        try {
            // Request ke API
            const response = await axios.get(API_URL, {
                headers: {
                    'mapikey': API_KEY,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                },
                timeout: 10000 // Timeout 10 detik
            });

            // Validasi struktur response
            if (response.data && response.data.data && Array.isArray(response.data.data.otps)) {
                const numbers = response.data.data.otps;
                const cache = getCache();
                let isCacheUpdated = false;

                // Loop setiap item dari API
                for (const item of numbers) {
                    
                    // 1. Format Nomor (Tambah + jika belum ada)
                    let phone = item.number ? item.number.toString() : "";
                    if (phone && !phone.startsWith('+')) {
                        phone = "+" + phone;
                    }

                    // 2. Ambil Message & OTP Code
                    const fullMessage = item.otp || ""; 
                    const otpCode = extractOtp(fullMessage);
                    
                    // Agar lebih akurat kita pakai nid sebagai bagian dari key cache
                    const uniqueId = item.nid || `${otpCode}_${phone}`;
                    
                    // Cek Cache (logic cek duplikat?)
                    if (otpCode && !cache[uniqueId]) {
                        
                        // Tandai sebagai terkirim
                        cache[uniqueId] = { t: new Date().toISOString() };
                        isCacheUpdated = true;

                        // Simpan ke Log File (SMC.json)
                        const entry = {
                            service: item.operator || "Unknown Service",
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
                        // Simpan 100 log terakhir saja
                        fs.writeFileSync(SMC_JSON_FILE, JSON.stringify(existingLog.slice(-100), null, 2));

                        // --- KIRIM TELEGRAM ---
                        const emoji = getCountryEmoji(item.country || "");
                        
                        // Sanitasi HTML
                        const safePhone = maskPhone(phone);
                        const safeCountry = escapeHtml(item.country || "Unknown");
                        const safeService = escapeHtml(item.operator || "Service");
                        const safeFullMessage = escapeHtml(fullMessage);
                        
                        // Format Pesan Telegram
                        const msg = `💭 <b>New Message Received</b>\n\n` +
                                    `<b>☎️ Number:</b> <code>${safePhone}</code>\n` +
                                    `<b>🌍 Country:</b> <b>${safeCountry} ${emoji}</b>\n` +
                                    `<b>⚙️ Service:</b> <b>${safeService}</b>\n\n` +
                                    `🔐 OTP: <code>${otpCode}</code>\n\n` +
                                    `<b>FULL MESSAGE:</b>\n` +
                                    `<blockquote>${safeFullMessage}</blockquote>\n` +
                                    `<code>ID: ${item.nid}</code>`; // Tambahan info ID
                        
                        await sendTelegram(msg, otpCode);
                        totalSent++;
                        
                        // Delay ssend TG
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }

                if (isCacheUpdated) {
                    saveToCache(cache);
                }
            } else {
                console.log("⚠️ [API] Format data tidak sesuai atau kosong.");
            }

        } catch (e) {
            if (e.response) {
                console.error(`❌ [API ERROR] Status: ${e.response.status} - ${JSON.stringify(e.response.data)}`);
            } else {
                console.error(`❌ [API ERROR] Network: ${e.message}`);
            }
        }

        // Delay Loop (Jeda 2 detik sebelum request lagi agar tidak kena rate limit)
        await new Promise(r => setTimeout(r, 2000));
    }
}

// Jalankan Monitor
startApiMonitor();
