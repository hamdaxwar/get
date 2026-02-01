const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ==================== KONFIGURASI ====================
const CONFIG = {
    BOT_TOKEN: "8264103317:AAG_-LZQIxrMDIlLlttWQqIvA9xu_GNMwnc",
    CHAT_ID: "-1003358198353",
    DASHBOARD_URL: "https://stexsms.com/mdashboard/console",
    CDP_URL: "http://127.0.0.1:9222",
    ALLOWED_SERVICES: ['whatsapp', 'facebook'],
    BANNED_COUNTRIES: ['angola']
};

// Global State
let SENT_MESSAGES = new Map();
let CACHE_SET = new Set(); // Pengganti MessageFilter untuk memori efisien

// Load Country Emoji (Pastikan file country.json ada di folder yang sama)
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
    if (sLower.includes('instagram')) return 'Instagram';
    if (sLower.includes('telegram')) return 'Telegram';
    if (sLower.includes('mnitnetwork')) return 'M-NIT Network';
    return service.trim();
};

// ==================== FUNGSI SIMPAN JSON (SAMA PERSIS) ====================
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
            try {
                dataList = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            } catch (e) { dataList = []; }
        }

        if (dataList.some(item => item.range === rangeVal)) return;

        const emojiChar = getCountryEmoji(countryName);
        const newEntry = {
            "range": rangeVal,
            "country": countryName.toUpperCase(),
            "emoji": emojiChar,
            "service": shortService
        };

        dataList.push(newEntry);
        if (dataList.length > 10) dataList = dataList.slice(-10);

        // Menulis dengan ensure_ascii=true (default JSON.stringify adalah unicode)
        fs.writeFileSync(filePath, JSON.stringify(dataList, null, 2), 'utf-8');
        console.log(`📂 [JSON] ${shortService} Saved: ${rangeVal}`);
    } catch (e) {
        console.error(`❌ JSON Error: ${e.message}`);
    }
};

// ==================== TELEGRAM LOGIC ====================

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
    const keyboard = {
        inline_keyboard: [[{ text: "📞GetNumber", url: "https://t.me/myzuraisgoodbot?start=ZuraBot" }]]
    };

    try {
        // Hapus pesan lama jika ada
        if (SENT_MESSAGES.has(rangeVal)) {
            const oldMid = SENT_MESSAGES.get(rangeVal).message_id;
            await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/deleteMessage`, {
                chat_id: CONFIG.CHAT_ID,
                message_id: oldMid
            }).catch(() => {});
        }

        const res = await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`, {
            chat_id: CONFIG.CHAT_ID,
            text: text,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });

        if (res.data.ok) {
            let currentCount = SENT_MESSAGES.has(rangeVal) ? SENT_MESSAGES.get(rangeVal).count : 1;
            SENT_MESSAGES.set(rangeVal, {
                message_id: res.data.result.message_id,
                count: currentCount,
                timestamp: Date.now()
            });
            saveToInlineJson(rangeVal, country, service);
        }
    } catch (e) {
        console.error(`❌ Telegram Error: ${e.message}`);
    }
}

// ==================== MAIN MONITOR CLASS ====================

async function startMonitor() {
    console.log("🚀 [RANGE] Karyawan standby... Menunggu 7 detik.");
    await new Promise(r => setTimeout(r, 7000));

    let browser;
    try {
        browser = await chromium.connectOverCDP(CONFIG.CDP_URL);
        const context = browser.contexts()[0];
        const page = await context.newPage();
        
        console.log(`✅ [RANGE] Numpang Tab Berhasil: ${CONFIG.DASHBOARD_URL}`);
        await page.goto(CONFIG.DASHBOARD_URL, { waitUntil: 'networkidle' });

        const CONSOLE_SELECTOR = ".group.flex.flex-col.sm\\:flex-row.sm\\:items-start.gap-3.p-3.rounded-lg";

        while (true) {
            try {
                // Pastikan berada di URL yang benar
                if (!page.url().includes('/console')) {
                    await page.goto(CONFIG.DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
                }

                await page.waitForSelector(CONSOLE_SELECTOR, { timeout: 5000 }).catch(() => {});
                const elements = await page.locator(CONSOLE_SELECTOR).all();

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

                        const cacheKey = `${phone}_${fullMessage.length}`; // Simple unique key

                        if (phone.includes('XXX') && !CACHE_SET.has(cacheKey)) {
                            CACHE_SET.add(cacheKey);
                            
                            let data = SENT_MESSAGES.get(phone) || { count: 0 };
                            data.count += 1;
                            
                            const text = formatLiveMessage(phone, data.count, country, service, fullMessage);
                            await sendToTelegram(phone, country, service, text);
                        }
                    } catch (e) { continue; }
                }

                // Cleanup pesan > 10 menit
                const now = Date.now();
                for (let [range, val] of SENT_MESSAGES.entries()) {
                    if (now - val.timestamp > 600000) SENT_MESSAGES.delete(range);
                }

            } catch (e) {
                console.error(`❌ Loop Error: ${e.message}`);
            }
            await new Promise(r => setTimeout(r, 10000));
        }
    } catch (e) {
        console.error(`❌ Fatal Error: ${e.message}`);
        process.exit(1);
    }
}

startMonitor();
