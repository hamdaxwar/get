// scraper.js
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

// Status teks statis (lebih cepat)
function getProgressMessage(prefixRange, numCount) {
    return `<i>Menunggu di antrian sistem aktif...</i>\n\n` +
           `<blockquote>Range: <code>${prefixRange}</code> | Jumlah: <code>${numCount}</code></blockquote>\n` +
           `note: <i>please wait...</i>`;
}

// --- Browser Control ---
async function initBrowser() {
    if (state.browser && state.browser.isConnected()) return state.browser;

    if (state.browser) {
        try { await state.browser.close(); } catch {}
    }

    console.log("[BROWSER] Launching Chromium...");
    state.browser = await chromium.launch({
        headless: config.HEADLESS,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            '--disable-extensions',
            '--remote-debugging-port=9222'
        ]
    });

    const context = await state.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    state.sharedPage = await context.newPage();

    // Blokir resource berat agar cepat & hemat RAM
    await state.sharedPage.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', route => route.abort());

    try {
        await performLogin(state.sharedPage, config.STEX_EMAIL, config.STEX_PASSWORD, config.LOGIN_URL);
        await state.sharedPage.goto(config.TARGET_URL, { waitUntil: 'domcontentloaded' });
        console.log("[BROWSER] Ready on Target URL.");
    } catch (e) {
        console.error(`[BROWSER ERROR] ${e.message}`);
    }
}

// --- Ambil Nomor Parallel ---
async function getAllNumbersParallel(page, numToFetch) {
    try {
        const rowsData = await page.$$eval('tbody tr', rows =>
            rows.map(row => {
                const phoneEl = row.querySelector('td:nth-child(1) span.font-mono');
                const statusEl = row.querySelector('td:nth-child(1) div:nth-child(2) span');
                const countryEl = row.querySelector('td:nth-child(2) span.text-slate-200');
                return {
                    numberRaw: phoneEl ? phoneEl.innerText.trim() : null,
                    statusText: statusEl ? statusEl.innerText.trim().toLowerCase() : "unknown",
                    country: countryEl ? countryEl.innerText.trim().toUpperCase() : "UNKNOWN"
                };
            })
        );

        const currentNumbers = [];
        const seen = new Set();

        for (const res of rowsData) {
            if (!res.numberRaw) continue;
            const normalized = res.numberRaw.replace(/[\s-]/g, "");
            const number = normalized.startsWith('+') ? normalized : '+' + normalized;

            if (db.isInCache(number)) continue;
            if (res.statusText.includes("success") || res.statusText.includes("failed")) continue;
            if (!seen.has(number)) {
                currentNumbers.push({ number, country: res.country, status: res.statusText });
                seen.add(number);
            }
            if (currentNumbers.length >= numToFetch) break;
        }

        return currentNumbers;
    } catch {
        return [];
    }
}

// --- Action Typing Indicator ---
async function actionTask(userId) {
    const interval = setInterval(() => tg.tgSendAction(userId, "typing"), 4500);
    return interval;
}

// --- Proses Input User ---
async function processUserInput(userId, prefix, clickCount, usernameTg, firstNameTg, messageIdToEdit = null) {
    let msgId = messageIdToEdit || state.pendingMessage[userId];
    let actionInterval = null;
    const numToFetch = clickCount;

    // Kirim pesan tunggu awal
    if (!msgId) msgId = await tg.tgSend(userId, getProgressMessage(prefix, numToFetch));
    else await tg.tgEdit(userId, msgId, getProgressMessage(prefix, numToFetch));

    const release = await playwrightLock.acquire();
    try {
        actionInterval = await actionTask(userId);

        // Pastikan browser siap
        if (!state.sharedPage || !state.browser.isConnected()) await initBrowser();
        const page = state.sharedPage;

        const INPUT_SELECTOR = "input[name='numberrange']";
        await page.waitForSelector(INPUT_SELECTOR, { state: 'visible', timeout: 10000 });
        await page.fill(INPUT_SELECTOR, "");
        await page.fill(INPUT_SELECTOR, prefix);
        await new Promise(r => setTimeout(r, 500));

        const BUTTON_SELECTOR = "button:has-text('Get Number')";
        await page.waitForSelector(BUTTON_SELECTOR, { state: 'visible', timeout: 10000 });
        for (let i = 0; i < clickCount; i++) await page.click(BUTTON_SELECTOR, { force: true });

        // Ambil nomor (dua putaran)
        let foundNumbers = [];
        const rounds = [5.0, 5.0];
        const checkInterval = 0.5;

        for (let r = 0; r < rounds.length; r++) {
            const start = Date.now() / 1000;
            while ((Date.now() / 1000 - start) < rounds[r]) {
                foundNumbers = await getAllNumbersParallel(page, numToFetch);
                if (foundNumbers.length >= numToFetch) break;
                await new Promise(r => setTimeout(r, checkInterval * 1000));
            }
            if (r === 1 && foundNumbers.length < numToFetch) {
                await page.click(BUTTON_SELECTOR, { force: true });
                await new Promise(r => setTimeout(r, 1500));
                foundNumbers = await getAllNumbersParallel(page, numToFetch);
            }
            if (foundNumbers.length >= numToFetch) break;
        }

        if (!foundNumbers.length) {
            await tg.tgEdit(userId, msgId, "❌ NOMOR TIDAK DI TEMUKAN. Coba lagi atau ganti range.");
            return;
        }

        const mainCountry = foundNumbers[0].country || "UNKNOWN";
        foundNumbers.forEach(entry => {
            db.saveCache({ number: entry.number, country: entry.country, user_id: userId, time: Date.now() });
            db.addToWaitList(entry.number, userId, usernameTg, firstNameTg);
        });

        state.lastUsedRange[userId] = prefix;
        const emoji = config.COUNTRY_EMOJI[mainCountry] || "🏴‍☠️";

        // Hasil akhir
        let msg = `✅ The number is ready\n\n`;
        foundNumbers.slice(0, numToFetch).forEach((entry, idx) => {
            if (numToFetch === 1) msg += `📞 Number : <code>${entry.number}</code>\n`;
            else msg += `📞 Number ${idx + 1} : <code>${entry.number}</code>\n`;
        });
        msg += `${emoji} COUNTRY : ${mainCountry}\n🏷️ Range : <code>${prefix}</code>\n\n<b>🤖 Number available please use, Waiting for OTP</b>\n`;

        const inlineKb = {
            inline_keyboard: [
                [{ text: "🔄 Change 1 Number", callback_data: `change_num:1:${prefix}` }],
                [{ text: "🔄 Change 3 Number", callback_data: `change_num:3:${prefix}` }],
                [{ text: "🔐 OTP Grup", url: config.GROUP_LINK_1 }, { text: "🌐 Change Range", callback_data: "getnum" }]
            ]
        };

        await tg.tgEdit(userId, msgId, msg, inlineKb);

    } catch (e) {
        console.error(`[PROCESS ERROR] ${e.message}`);
        if (e.name === 'TimeoutError') {
            if (msgId) await tg.tgEdit(userId, msgId, "❌ Timeout web. Tombol atau web lambat.");
        } else {
            if (msgId) await tg.tgEdit(userId, msgId, `❌ Terjadi kesalahan (${e.message}).`);
        }
    } finally {
        if (actionInterval) clearInterval(actionInterval);
        release();
    }
}

module.exports = {
    initBrowser,
    processUserInput,
    getProgressMessage
};
