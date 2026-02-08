const { chromium } = require('playwright');
const config = require('../config');
const { performLogin } = require('../login.js');
const { state, playwrightLock } = require('./state');
const db = require('./database');
const tg = require('./telegram');

// --- Helper Functions ---
function normalizeNumber(number) {
    let norm = String(number).trim().replace(/[\s-]/g, "");
    if (!norm.startsWith('+') && /^\d+$/.test(norm)) norm = '+' + norm;
    return norm;
}

function getProgressMessage(currentStep, prefixRange, numCount) {
    const progressRatio = Math.min(currentStep / 12, 1.0);
    const filledCount = Math.ceil(progressRatio * config.BAR.MAX_LENGTH);
    const emptyCount = config.BAR.MAX_LENGTH - filledCount;
    const bar = config.BAR.FILLED.repeat(filledCount) + config.BAR.EMPTY.repeat(emptyCount);
    let status = config.STATUS_MAP[currentStep] || "Processing...";
    return `<code>${status}</code>\n<blockquote>Range: <code>${prefixRange}</code> | Jumlah: <code>${numCount}</code></blockquote>\n<code>Load:</code> [${bar}]`;
}

// --- Browser Control ---
async function initBrowser() {
    if (state.browser && state.browser.isConnected()) return state.browser;

    state.browser = await chromium.launch({
        headless: config.HEADLESS,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await state.browser.newContext({
        permissions: ['clipboard-read', 'clipboard-write']
    });

    state.sharedPage = await context.newPage();
    // Blokir resource berat agar loading ngebut
    await state.sharedPage.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', route => route.abort());

    try {
        await performLogin(state.sharedPage, config.STEX_EMAIL, config.STEX_PASSWORD, config.LOGIN_URL);
    } catch (e) {
        console.error(`[BROWSER ERROR] Login Failed: ${e.message}`);
    }
}

async function getNumberFromClipboard(page) {
    return await page.evaluate(async () => {
        try { return await navigator.clipboard.readText(); } catch { return null; }
    });
}

// --- Main Logic (DIRECT URL METHOD) ---
async function processUserInput(userId, prefix, clickCount, usernameTg, firstNameTg, messageIdToEdit = null) {
    let msgId = messageIdToEdit || state.pendingMessage[userId];
    const release = await playwrightLock.acquire();
    let actionInterval = setInterval(() => tg.tgSendAction(userId, "typing"), 4500);
    
    try {
        if (!state.sharedPage || state.sharedPage.isClosed()) await initBrowser();
        const page = state.sharedPage;
        
        if (!msgId) msgId = await tg.tgSend(userId, getProgressMessage(1, prefix, clickCount));

        // LANGKAH 1: Navigasi langsung pake link prefix (Lebih Cepat!)
        const targetUrl = `https://stexsms.com/mdashboard/getnum?range=${prefix}`;
        console.log(`[NAVIGATE] Going to: ${targetUrl}`);
        
        await page.goto(targetUrl, { waitUntil: 'commit', timeout: 20000 });
        
        const BUTTON_SELECTOR = "button:has-text('Get Number')";
        
        // Pastikan tombol sudah muncul (biasanya instan kalau pake link direct)
        await page.waitForSelector(BUTTON_SELECTOR, { state: 'visible', timeout: 10000 });

        let foundNumbers = [];
        let seen = new Set();

        // LANGKAH 2: Klik Loop (Ambil 3 nomor ke clipboard)
        for (let i = 0; i < clickCount; i++) {
            await page.click(BUTTON_SELECTOR, { force: true });
            
            // Tunggu sebentar sampai clipboard berubah
            await new Promise(r => setTimeout(r, 800)); 
            
            const rawNum = await getNumberFromClipboard(page);
            if (rawNum) {
                const num = normalizeNumber(rawNum);
                // Pastikan nomor baru & belum pernah muncul
                if (!db.isInCache(num) && !seen.has(num)) {
                    foundNumbers.push({ number: num, country: "DETECTING..." });
                    seen.add(num);
                }
            }
            
            // Update Progress di Tele
            let step = Math.min(2 + (i * 3), 11);
            await tg.tgEdit(userId, msgId, getProgressMessage(step, prefix, clickCount));
        }

        if (foundNumbers.length === 0) {
            await tg.tgEdit(userId, msgId, "❌ Gagal ambil nomor dari clipboard. Coba lagi.");
            return;
        }

        // LANGKAH 3: Simpan & Kirim
        const final = foundNumbers.slice(0, clickCount);
        final.forEach(n => {
            db.saveCache({ number: n.number, country: n.country, user_id: userId, time: Date.now() });
            db.addToWaitList(n.number, userId, usernameTg, firstNameTg);
        });

        // Deteksi negara (opsional dari tabel jika clipboard ga bawa info negara)
        let displayCountry = "UNKNOWN";
        try {
            const countryText = await page.$eval('tbody tr td:nth-child(2)', el => el.innerText.trim()).catch(() => "UNKNOWN");
            displayCountry = countryText.toUpperCase();
        } catch(e) {}

        const emoji = config.COUNTRY_EMOJI[displayCountry] || "🏳️";
        
        let resMsg = `✅ <b>Number Ready</b>\n\n`;
        final.forEach((n, idx) => {
            resMsg += `📞 No ${idx+1}: <code>${n.number}</code>\n`;
        });
        resMsg += `\n${emoji} Country: ${displayCountry}\n🏷️ Range: <code>${prefix}</code>\n\n<b>Silahkan gunakan, menunggu OTP...</b>`;

        await tg.tgEdit(userId, msgId, resMsg, {
            inline_keyboard: [
                [{ text: "🔄 Ganti 1", callback_data: `change_num:1:${prefix}` }, { text: "🔄 Ganti 3", callback_data: `change_num:3:${prefix}` }],
                [{ text: "🌐 Menu Utama", callback_data: "getnum" }]
            ]
        });

        // LANGKAH 4: Opsional - Navigasi ke blank page biar ringan pas idle
        await page.goto('about:blank').catch(() => {});

    } catch (e) {
        console.error(`[FATAL ERROR] ${e.message}`);
        await tg.tgEdit(userId, msgId, `❌ Error: ${e.message.substring(0, 50)}...`);
    } finally {
        clearInterval(actionInterval);
        release();
    }
}

module.exports = { initBrowser, processUserInput, getProgressMessage };
