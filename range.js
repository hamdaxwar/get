const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ==================== KONFIGURASI ====================
const CONFIG = {
    BOT_TOKEN: "8264103317:AAG_-LZQIxrMDIlLlttWQqIvA9xu_GNMwnc",
    CHAT_ID: "-1003358198353",
    DATA_SOURCE: "https://zura14.web.id/rane.json",
    ALLOWED_SERVICES: ['whatsapp', 'facebook'],
    BANNED_COUNTRIES: ['angola'],
    FETCH_INTERVAL: 10000, // Ambil data setiap 10 detik
    SEND_DELAY: 2000,
    INLINE_JSON_PATH: path.join(__dirname, 'inline.json')
};

let SENT_MESSAGES = new Map(); // Untuk tracking message_id (fitur delete old message)
let CACHE_SET = new Set();     // Untuk cegah duplikat pengiriman
let MESSAGE_QUEUE = []; 
let IS_PROCESSING_QUEUE = false; 

// Load Country Emoji
let COUNTRY_EMOJI = {};
try {
    COUNTRY_EMOJI = require('./country.json');
} catch (e) {
    console.log("⚠️ country.json tidak ditemukan, menggunakan emoji default.");
}

// ==================== UTILITY FUNCTIONS ====================

const getCountryEmoji = (countryName) => (countryName ? (COUNTRY_EMOJI[countryName.toUpperCase()] || "🏴‍☠️") : "🏴‍☠️");

const cleanServiceName = (service) => {
    if (!service) return "Unknown";
    const sLower = service.toLowerCase();
    if (sLower.includes('facebook')) return 'Facebook';
    if (sLower.includes('whatsapp')) return 'WhatsApp';
    return service.trim();
};

const saveToInlineJson = (rangeVal, countryName, service) => {
    const serviceMap = { 'whatsapp': 'WA', 'facebook': 'FB' };
    const serviceKey = service.toLowerCase();
    if (!serviceMap[serviceKey]) return;
    const shortService = serviceMap[serviceKey];

    try {
        let dataList = [];
        if (fs.existsSync(CONFIG.INLINE_JSON_PATH)) {
            try { dataList = JSON.parse(fs.readFileSync(CONFIG.INLINE_JSON_PATH, 'utf-8')); } catch (e) { dataList = []; }
        }
        if (dataList.some(item => item.range === rangeVal)) return;
        
        dataList.push({
            "range": rangeVal, 
            "country": countryName.toUpperCase(),
            "emoji": getCountryEmoji(countryName), 
            "service": shortService
        });

        if (dataList.length > 15) dataList = dataList.slice(-15);
        fs.writeFileSync(CONFIG.INLINE_JSON_PATH, JSON.stringify(dataList, null, 2), 'utf-8');
    } catch (e) {
        console.error("❌ Error writing inline.json:", e.message);
    }
};

const formatLiveMessage = (rangeVal, count, countryName, service, fullMessage) => {
    const emoji = getCountryEmoji(countryName);
    const rangeWithCount = count > 1 ? `<code>${rangeVal}</code> (${count}x)` : `<code>${rangeVal}</code>`;
    const msgEscaped = fullMessage.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    
    return `🔥<b>Live message new range</b>\n\n` +
           `📱Range    : ${rangeWithCount}\n` +
           `${emoji} Country : ${countryName}\n` +
           `⚙️ Service : ${service}\n\n` +
           `🗯️Message Available :\n` +
           `<blockquote>${msgEscaped}</blockquote>`;
};

// ==================== QUEUE PROCESSOR ====================

async function processQueue() {
    if (IS_PROCESSING_QUEUE || MESSAGE_QUEUE.length === 0) return;
    IS_PROCESSING_QUEUE = true;

    while (MESSAGE_QUEUE.length > 0) {
        const item = MESSAGE_QUEUE.shift(); 
        try {
            // Hapus pesan lama jika nomor yang sama muncul lagi (opsional)
            if (SENT_MESSAGES.has(item.rangeVal)) {
                const oldMid = SENT_MESSAGES.get(item.rangeVal).message_id;
                await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/deleteMessage`, {
                    chat_id: CONFIG.CHAT_ID, 
                    message_id: oldMid
                }).catch(() => {});
            }

            const res = await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`, {
                chat_id: CONFIG.CHAT_ID,
                text: item.text,
                parse_mode: 'HTML',
                reply_markup: { 
                    inline_keyboard: [[{ text: "📞GetNumber", url: "https://t.me/myzuraisgoodbot?start=ZuraBot" }]] 
                }
            });

            if (res.data.ok) {
                SENT_MESSAGES.set(item.rangeVal, {
                    message_id: res.data.result.message_id,
                    timestamp: Date.now()
                });
                saveToInlineJson(item.rangeVal, item.country, item.service);
                console.log(`✅ [SENT] ${item.rangeVal} - ${item.service}`);
            }
        } catch (e) {
            console.error(`❌ [TELEGRAM ERROR] ${e.message}`);
        }
        await new Promise(r => setTimeout(r, CONFIG.SEND_DELAY));
    }
    IS_PROCESSING_QUEUE = false;
}

// ==================== CORE MONITORING ====================

async function fetchData() {
    try {
        console.log(`🌐 Checking updates from API...`);
        const response = await axios.get(`${CONFIG.DATA_SOURCE}?t=${Date.now()}`); // Anti cache
        const items = response.data.data || [];

        for (const item of items) {
            const country = item.country || "Unknown";
            const service = cleanServiceName(item.service);
            const range = item.range || "";
            const time = item.detected_at || "";
            const msg = item.full_msg || "";

            // 1. Filter Banned Country
            if (CONFIG.BANNED_COUNTRIES.includes(country.toLowerCase())) continue;

            // 2. Filter Allowed Service
            if (!CONFIG.ALLOWED_SERVICES.some(s => service.toLowerCase().includes(s))) continue;

            // 3. Cek Duplikat berdasarkan Range + Waktu Deteksi
            const cacheKey = `${range}_${time}`;
            if (range.includes('XXX') && !CACHE_SET.has(cacheKey)) {
                CACHE_SET.add(cacheKey);

                // Hitung repetisi sederhana (jika dibutuhkan)
                const newCount = 1; 

                MESSAGE_QUEUE.push({
                    rangeVal: range,
                    country,
                    service,
                    count: newCount,
                    text: formatLiveMessage(range, newCount, country, service, msg)
                });
                
                processQueue();
            }
        }

        // Cleanup CACHE_SET agar tidak membengkak (hapus data lama)
        if (CACHE_SET.size > 500) {
            const arr = Array.from(CACHE_SET);
            CACHE_SET = new Set(arr.slice(-200));
        }

    } catch (e) {
        console.error(`❌ [FETCH ERROR] ${e.message}`);
    }
}

// Jalankan Loop
console.log("🚀 [RANGE MONITOR] Standalone Active...");
fetchData();
setInterval(fetchData, CONFIG.FETCH_INTERVAL);
