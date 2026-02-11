const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG = {
    BOT_TOKEN: "8264103317:AAG_-LZQIxrMDIlLlttWQqIvA9xu_GNMwnc",
    CHAT_ID: "-1003358198353",
    CACHE_FILE: path.join(__dirname, 'cache_range.json'),
    ALLOWED_SERVICES: ['whatsapp', 'facebook'],
    BANNED_COUNTRIES: ['angola'],
    SEND_DELAY: 2000,
    POLLING_INTERVAL: 5000 // Cek file setiap 5 detik
};

let SENT_MESSAGES = new Map();
let CACHE_SET = new Set();
let MESSAGE_QUEUE = []; 
let IS_PROCESSING_QUEUE = false; 

let COUNTRY_EMOJI = {};
try { 
    COUNTRY_EMOJI = require('./country.json'); 
} catch (e) {
    console.log("⚠️ [RANGE] country.json tidak ditemukan, menggunakan emoji default.");
}

const getCountryEmoji = (name) => (name ? (COUNTRY_EMOJI[name.toUpperCase()] || "🏴‍☠️") : "🏴‍☠️");

const cleanServiceName = (s) => {
    if (!s) return "Unknown";
    const low = s.toLowerCase();
    if (low.includes('facebook')) return 'Facebook';
    if (low.includes('whatsapp')) return 'WhatsApp';
    return s.trim();
};

const formatLiveMessage = (rangeVal, count, country, service, msg) => {
    const emoji = getCountryEmoji(country);
    const header = count > 1 ? `<code>${rangeVal}</code> (${count}x)` : `<code>${rangeVal}</code>`;
    const escaped = msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `🌤️<b>Live message new range</b>\n\n☎️Range    : ${header}\n${emoji} Country : ${country}\n📪 Service : ${service}\n\n🗯️Message Available :\n<blockquote>${escaped}</blockquote>`;
};

async function monitorLocalCache() {
    console.log("🚀 [RANGE] Service Standalone Active. Reading from cache_range.json...");

    while (true) {
        try {
            if (fs.existsSync(CONFIG.CACHE_FILE)) {
                const rawData = fs.readFileSync(CONFIG.CACHE_FILE, 'utf8');
                const dataItems = JSON.parse(rawData);

                for (const item of dataItems) {
                    try {
                        const country = item.country || "Unknown";
                        if (CONFIG.BANNED_COUNTRIES.includes(country.toLowerCase())) continue;

                        const service = cleanServiceName(item.service);
                        if (!CONFIG.ALLOWED_SERVICES.some(s => service.toLowerCase().includes(s))) continue;

                        const phone = item.range || "N/A";
                        const fullMessage = (item.full_msg || "").trim();

                        // Filter hanya untuk nomor yang mengandung XXX (Range)
                        if (phone.includes('XXX')) {
                            // Unique key berdasarkan nomor dan potongan pesan agar tidak spam
                            const cacheKey = `${phone}_${fullMessage.slice(0, 20)}`; 
                            
                            if (!CACHE_SET.has(cacheKey)) {
                                CACHE_SET.add(cacheKey);
                                
                                const cur = SENT_MESSAGES.get(phone) || { count: 0 };
                                const newCount = cur.count + 1;

                                MESSAGE_QUEUE.push({ 
                                    rangeVal: phone, 
                                    country, 
                                    service, 
                                    count: newCount, 
                                    text: formatLiveMessage(phone, newCount, country, service, fullMessage) 
                                });
                                
                                if (!IS_PROCESSING_QUEUE) processQueue();
                            }
                        }
                    } catch (innerErr) {
                        // Skip item bermasalah
                    }
                }
            }
        } catch (err) { 
            console.error("❌ [RANGE] File Read Error:", err.message);
        }
        
        // Menunggu sebelum pengecekan berikutnya
        await new Promise(r => setTimeout(r, CONFIG.POLLING_INTERVAL));
    }
}

async function processQueue() {
    IS_PROCESSING_QUEUE = true;
    while (MESSAGE_QUEUE.length > 0) {
        const item = MESSAGE_QUEUE.shift();
        try {
            await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`, {
                chat_id: CONFIG.CHAT_ID, 
                text: item.text, 
                parse_mode: 'HTML',
                reply_markup: { 
                    inline_keyboard: [[{ text: "📞 Get Number", url: "https://t.me/myzuraisgoodbot" }]] 
                }
            });
            
            SENT_MESSAGES.set(item.rangeVal, { count: item.count, timestamp: Date.now() });
            console.log(`✅ [RANGE] Sent: ${item.rangeVal} (${item.service})`);
        } catch (e) {
            console.error("❌ [RANGE] Telegram Error:", e.response?.data?.description || e.message);
        }
        await new Promise(r => setTimeout(r, CONFIG.SEND_DELAY));
    }
    IS_PROCESSING_QUEUE = false;
}

// Jalankan monitoring
monitorLocalCache();
