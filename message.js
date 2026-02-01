const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { state } = require('./helpers/state');

// ================= KONFIGURASI =================
const BOT_TOKEN = "7562117237:AAFQnb5aCmeSHHi_qAJz3vkoX4HbNGohe38";
const CHAT_ID = "-1003492226491";
const ADMIN_ID = "7184123643";
const TELEGRAM_BOT_LINK = "https://t.me/myzuraisgoodbot";
const TELEGRAM_ADMIN_LINK = "https://t.me/Imr1d";

const DASHBOARD_URL = "https://stexsms.com/mdashboard/getnum";
const SMC_JSON_FILE = path.join(__dirname, "smc.json");
const WAIT_JSON_FILE = path.join(__dirname, "helpers", "wait.json");
const CACHE_FILE = path.join(__dirname, 'otp_cache.json');
const COUNTRY_EMOJI = require('./country.json');

let totalSent = 0;
let lastUpdateId = 0;
const startTime = Date.now();
let monitorPage = null;

// ================= UTILS =================

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

function getUserData(phoneNumber) {
    if (!fs.existsSync(WAIT_JSON_FILE)) return { username: "unknown", user_id: null };
    try {
        const waitList = JSON.parse(fs.readFileSync(WAIT_JSON_FILE));
        const cleanTarget = phoneNumber.replace(/[^\d]/g, '');
        for (const entry of waitList) {
            const cleanEntry = String(entry.number || "").replace(/[^\d]/g, '');
            if (cleanTarget === cleanEntry) {
                return { username: entry.username || "unknown", user_id: entry.user_id };
            }
        }
    } catch (e) { /* ignore */ }
    return { username: "unknown", user_id: null };
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
        await axios.post(url, payload);
    } catch (e) {
        console.error(`❌ [TG] Error: ${e.message}`);
    }
}

// ================= COMMAND HANDLERS =================

async function checkTelegramCommands() {
    try {
        const resp = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`);
        if (resp.data && resp.data.result) {
            for (const u of resp.data.result) {
                lastUpdateId = u.update_id;
                const m = u.message;
                if (!m || String(m.from.id) !== String(ADMIN_ID)) continue;

                if (m.text === "/status") {
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const h = Math.floor(uptime / 3600);
                    const min = Math.floor((uptime % 3600) / 60);
                    const msg = `🤖 <b>Zura Status (Node)</b>\n⚡ Live: ✅\nUptime: <code>${h}h ${min}m</code>\nTotal Sent: <b>${totalSent}</b>`;
                    await sendTelegram(msg, null, ADMIN_ID);
                } else if (m.text === "/refresh") {
                    if (monitorPage) {
                        await monitorPage.reload({ waitUntil: 'networkidle' }).catch(() => {});
                        const p = `ss_${Date.now()}.png`;
                        await monitorPage.screenshot({ path: p, fullPage: true }).catch(() => {});
                        
                        const FormData = require('form-data');
                        const form = new FormData();
                        form.append('chat_id', ADMIN_ID);
                        form.append('caption', `📸 Live Refresh: <code>${new Date().toLocaleTimeString()}</code>`);
                        form.append('parse_mode', 'HTML');
                        form.append('photo', fs.createReadStream(p));
                        
                        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, form, {
                            headers: form.getHeaders()
                        }).catch(() => {});
                        
                        if (fs.existsSync(p)) fs.unlinkSync(p);
                    }
                }
            }
        }
    } catch (e) {}
}

// ================= MONITORING LOGIC =================

async function startSmsMonitor() {
    console.log("🚀 [MESSAGE] Monitoring SMS otomatis dimulai...");

    const checkState = setInterval(() => {
        if (state.browser) {
            clearInterval(checkState);
            console.log("✅ [MESSAGE] Browser siap. Menempel ke dashboard dalam 5 detik...");
            setTimeout(() => runLoop(), 5000);
        }
    }, 2000);

    async function runLoop() {
        while (true) {
            try {
                if (!monitorPage || monitorPage.isClosed()) {
                    const contexts = state.browser.contexts();
                    const context = contexts.length > 0 ? contexts[0] : await state.browser.newContext();
                    monitorPage = await context.newPage();
                    console.log("✅ [MESSAGE] Tab SMS aktif.");
                }

                if (!monitorPage.url().includes('/getnum')) {
                    await monitorPage.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
                }

                // Ambil data langsung dari API dashboard
                const responsePromise = monitorPage.waitForResponse(r => r.url().includes("/getnum/info"), { timeout: 5000 }).catch(() => null);
                await monitorPage.click('th:has-text("Number Info")', { timeout: 1000 }).catch(() => {});
                
                const response = await responsePromise;
                if (response) {
                    const json = await response.json();
                    const numbers = json?.data?.numbers || [];

                    for (const item of numbers) {
                        if (item.status === 'success' && item.message) {
                            const otp = extractOtp(item.message);
                            const phone = "+" + item.number;
                            const key = `${otp}_${phone}`;
                            const cache = getCache();

                            if (otp && !cache[key]) {
                                cache[key] = { t: new Date().toISOString() };
                                saveToCache(cache);

                                // Simpan ke smc.json di Root
                                const entry = {
                                    service: item.full_number || "Service",
                                    number: phone,
                                    otp: otp,
                                    full_message: item.message,
                                    timestamp: new Date().toLocaleString()
                                };
                                
                                let existing = [];
                                if (fs.existsSync(SMC_JSON_FILE)) {
                                    try { existing = JSON.parse(fs.readFileSync(SMC_JSON_FILE)); } catch(e){}
                                }
                                existing.push(entry);
                                fs.writeFileSync(SMC_JSON_FILE, JSON.stringify(existing.slice(-100), null, 2));

                                // Kirim Telegram seketika
                                const user = getUserData(phone);
                                const userTag = user.username !== "unknown" ? `@${user.username}` : "unknown";
                                const emoji = getCountryEmoji(item.country || "");
                                
                                const msg = `💭 <b>New Message Received</b>\n\n` +
                                            `<b>👤 User:</b> ${userTag}\n` +
                                            `<b>📱 Number:</b> <code>${maskPhone(phone)}</code>\n` +
                                            `<b>🌍 Country:</b> <b>${item.country || "N/A"} ${emoji}</b>\n` +
                                            `<b>✅ Service:</b> <b>${item.full_number || "N/A"}</b>\n\n` +
                                            `🔐 OTP: <code>${otp}</code>\n\n` +
                                            `<b>FULL MESSAGE:</b>\n` +
                                            `<blockquote>${item.message}</blockquote>`;
                                
                                await sendTelegram(msg, otp);
                                totalSent++;
                            }
                        }
                    }
                }
            } catch (e) {
                console.error("❌ [MESSAGE] Error:", e.message);
            }
            // Tetap cek command admin (/status, /refresh)
            await checkTelegramCommands();
            await new Promise(r => setTimeout(r, 10000)); // Refresh setiap 10 detik
        }
    }
}

startSmsMonitor();
