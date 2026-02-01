const axios = require('axios');
const fs = require('fs');
const path = require('path');
// Import state yang sama dengan yang digunakan di scraper.js
const { state } = require('./helpers/state'); 

// ==================== KONFIGURASI ====================
const CONFIG = {
    BOT_TOKEN: "8264103317:AAG_-LZQIxrMDIlLlttWQqIvA9xu_GNMwnc",
    CHAT_ID: "-1003358198353",
    DASHBOARD_URL: "https://stexsms.com/mdashboard/console",
    ALLOWED_SERVICES: ['whatsapp', 'facebook'],
    BANNED_COUNTRIES: ['angola']
};

let SENT_MESSAGES = new Map();
let CACHE_SET = new Set();
const COUNTRY_EMOJI = require('./country.json');

// ==================== UTILITY FUNCTIONS ====================

const getCountryEmoji = (countryName) => {
    return COUNTRY_EMOJI[countryName.toUpperCase()] || "🏴‍☠️";
};

const cleanPhoneNumber = (phone) => {
    if (!phone) return "N/A";
    return phone.replace(/[^0-9X]/g, '') || phone;
};

const cleanServiceName = (service) => {
    if (!service) return "Unknown";
    const sLower = service.toLowerCase();
    if (sLower.includes('facebook') || sLower.includes('laz+nxcar')) return 'Facebook';
    if (sLower.includes('whatsapp')) return 'WhatsApp';
    return service.trim();
};

const saveToInlineJson = (rangeVal, countryName, service) => {
    const serviceMap = { 'whatsapp': 'WA', 'facebook': 'FB' };
    const serviceKey = service.toLowerCase();
    if (!serviceMap[serviceKey]) return;
    const shortService = serviceMap[serviceKey];

    try {
        const targetFolder = path.join(__dirname, 'get');
        const filePath = path.join(targetFolder, 'inline.json');
        if (!fs.existsSync(targetFolder)) fs.mkdirSync(targetFolder, { recursive: true });

        let dataList = [];
        if (fs.existsSync(filePath)) {
            try { dataList = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch (e) { dataList = []; }
        }

        if (dataList.some(item => item.range === rangeVal)) return;

        dataList.push({
            "range": rangeVal,
            "country": countryName.toUpperCase(),
            "emoji": getCountryEmoji(countryName),
            "service": shortService
        });

        if (dataList.length > 10) dataList = dataList.slice(-10);
        fs.writeFileSync(filePath, JSON.stringify(dataList, null, 2), 'utf-8');
    } catch (e) { console.error(`❌ JSON Error: ${e.message}`); }
};

const formatLiveMessage = (rangeVal, count, countryName, service, fullMessage) => {
    const emoji = getCountryEmoji(countryName);
    const rangeWithCount = count > 1 ? `<code>${rangeVal}</code> (${count}x)` : `<code>${rangeVal}</code>`;
    const msgEscaped = fullMessage.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    
    return `🔥Live message new range\n\n` +
           `📱Range    : ${rangeWithCount}\n` +
           `${emoji}Country : ${countryName}\n` +
           `⚙️ Service : ${service}\n\n` +
           `🗯️Message Available :\n` +
           `<blockquote>${msgEscaped}</blockquote>`;
};

async function sendToTelegram(rangeVal, country, service, text) {
    try {
        if (SENT_MESSAGES.has(rangeVal)) {
            const oldMid = SENT_MESSAGES.get(rangeVal).message_id;
            await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/deleteMessage`, {
                chat_id: CONFIG.CHAT_ID, message_id: oldMid
            }).catch(() => {});
        }

        const res = await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`, {
            chat_id: CONFIG.CHAT_ID,
            text: text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "📞GetNumber", url: "https://t.me/myzuraisgoodbot?start=ZuraBot" }]] }
        });

        if (res.data.ok) {
            let currentCount = (SENT_MESSAGES.get(rangeVal)?.count || 0) + 1;
            SENT_MESSAGES.set(rangeVal, {
                message_id: res.data.result.message_id,
                count: currentCount,
                timestamp: Date.now()
            });
            saveToInlineJson(rangeVal, country, service);
        }
    } catch (e) { console.error(`❌ Telegram Error: ${e.message}`); }
}

// ==================== MAIN MONITOR LOGIC ====================

async function startMonitor() {
    console.log("🚀 [RANGE] Mencari instance browser dari state...");

    // Loop pengecekan: Tunggu sampai main.js/scraper.js berhasil mengisi state.browser
    const checkState = setInterval(() => {
        if (state.browser) {
            clearInterval(checkState);
            console.log("✅ [RANGE] Browser ditemukan! Memulai monitoring...");
            runMonitoringLoop();
        }
    }, 2000);

    async function runMonitoringLoop() {
        let monitorPage = null;

        while (true) {
            try {
                // Gunakan state.browser yang diinisialisasi di main.js
                if (!monitorPage || monitorPage.isClosed()) {
                    const contexts = state.browser.contexts();
                    const context = contexts.length > 0 ? contexts[0] : await state.browser.newContext();
                    monitorPage = await context.newPage();
                    console.log("✅ [RANGE] Tab monitor berhasil dibuka.");
                }

                if (!monitorPage.url().includes('/console')) {
                    await monitorPage.goto(CONFIG.DASHBOARD_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
                }

                const CONSOLE_SELECTOR = ".group.flex.flex-col.sm\\:flex-row.sm\\:items-start.gap-3.p-3.rounded-lg";
                await monitorPage.waitForSelector(CONSOLE_SELECTOR, { timeout: 5000 }).catch(() => {});
                const elements = await monitorPage.locator(CONSOLE_SELECTOR).all();

                for (const el of elements) {
                    try {
                        const rawC = await el.locator(".flex-shrink-0 .text-\\[10px\\].text-slate-600.mt-1.font-mono").innerText();
                        const country = rawC.includes("•") ? rawC.split("•")[1].trim() : "Unknown";
                        if (CONFIG.BANNED_COUNTRIES.includes(country.toLowerCase())) continue;

                        const sRaw = await el.locator(".flex-grow.min-w-0 .text-xs.font-bold.text-blue-400").innerText();
                        const service = cleanServiceName(sRaw);
                        if (!CONFIG.ALLOWED_SERVICES.some(s => service.toLowerCase().includes(s))) continue;

                        const phoneRaw = await el.locator(".flex-grow.min-w-0 .text-\\[10px\\].font-mono").last().innerText();
                        const phone = cleanPhoneNumber(phoneRaw);
                        const msgRaw = await el.locator(".flex-grow.min-w-0 p").innerText();
                        const fullMessage = msgRaw.replace('➜', '').trim();

                        const cacheKey = `${phone}_${fullMessage.length}`;

                        if (phone.includes('XXX') && !CACHE_SET.has(cacheKey)) {
                            CACHE_SET.add(cacheKey);
                            const currentData = SENT_MESSAGES.get(phone) || { count: 0 };
                            await sendToTelegram(phone, country, service, formatLiveMessage(phone, currentData.count + 1, country, service, fullMessage));
                        }
                    } catch (e) { continue; }
                }

                const now = Date.now();
                for (let [range, val] of SENT_MESSAGES.entries()) {
                    if (now - val.timestamp > 600000) SENT_MESSAGES.delete(range);
                }

            } catch (e) { console.error(`❌ [RANGE] Loop Error: ${e.message}`); }
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

// Jalankan fungsi inisialisasi monitor
startMonitor();
