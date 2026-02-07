// scraper.js
const { chromium } = require('playwright');
const config = require('../config');
const { performLogin } = require('../login.js'); 
const { state, playwrightLock } = require('./state');
const db = require('./database');
const tg = require('./telegram');

// --- Helper Functions Internal ---
function normalizeNumber(number) {
    let norm = String(number).trim().replace(/[\s-]/g, "");
    if (!norm.startsWith('+') && /^\d+$/.test(norm)) {
        norm = '+' + norm;
    }
    return norm;
}

// --- Browser Control ---
async function initBrowser() {
    if (state.browser && !state.browser.isClosed()) return state.browser;

    console.log("[BROWSER] Launching Chromium...");
    state.browser = await chromium.launch({
        headless: config.HEADLESS,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
            '--no-zygote'
        ]
    });

    const context = await state.browser.newContext();
    state.sharedPage = await context.newPage();

    try {
        await performLogin(state.sharedPage, config.STEX_EMAIL, config.STEX_PASSWORD, config.LOGIN_URL);
        console.log("[BROWSER] Login Success. Redirecting to Target URL...");
        await state.sharedPage.goto(config.TARGET_URL, { waitUntil: 'domcontentloaded' });
        console.log("[BROWSER] Ready on Target URL.");
    } catch(e) {
        console.error("[BROWSER ERROR]", e.message);
    }
    return state.browser;
}

// --- Get Number Functions ---
async function getNumberAndCountryFromRow(rowSelector, page) {
    try {
        const row = page.locator(rowSelector);
        if (!(await row.isVisible())) return null;

        const phoneEl = row.locator("td:nth-child(1) span.font-mono");
        const numberRawList = await phoneEl.allInnerTexts();
        const numberRaw = numberRawList.length > 0 ? numberRawList[0].trim() : null;
        const number = numberRaw ? normalizeNumber(numberRaw) : null;
        if (!number || db.isInCache(number)) return null;

        const statusEl = row.locator("td:nth-child(1) div:nth-child(2) span");
        const statusTextList = await statusEl.allInnerTexts();
        const statusText = statusTextList.length > 0 ? statusTextList[0].trim().toLowerCase() : "unknown";
        if (statusText.includes("success") || statusText.includes("failed")) return null;

        const countryEl = row.locator("td:nth-child(2) span.text-slate-200");
        const countryList = await countryEl.allInnerTexts();
        const country = countryList.length > 0 ? countryList[0].trim().toUpperCase() : "UNKNOWN";

        return { number, country, status: statusText };
    } catch (e) {
        return null;
    }
}

async function getAllNumbersParallel(page, numToFetch) {
    const results = [];
    for (let i = 1; i <= numToFetch + 5; i++) {
        const res = await getNumberAndCountryFromRow(`tbody tr:nth-child(${i})`, page);
        if (res && !results.some(r => r.number === res.number)) results.push(res);
        if (results.length >= numToFetch) break;
    }
    return results;
}

// --- Main Action Logic ---
async function actionTask(userId) {
    return setInterval(() => tg.tgSendAction(userId, "typing"), 4500);
}

async function processUserInput(userId, prefix, clickCount, usernameTg, firstNameTg, messageIdToEdit = null) {
    let msgId = messageIdToEdit || state.pendingMessage[userId];
    let actionInterval = null;

    const release = await playwrightLock.acquire();
    try {
        // Start typing indicator
        actionInterval = await actionTask(userId);

        // Kirim teks awal tanpa progress
        const startText = `<i>Menunggu di antrian sistem aktif...</i>\n<blockquote>Range: ${prefix} | Jumlah: ${clickCount}</blockquote>\n<i>please wait...</i>`;
        if (!msgId) {
            msgId = await tg.tgSend(userId, startText);
            if (!msgId) return;
        } else {
            await tg.tgEdit(userId, msgId, startText);
        }

        // Ensure browser ready
        const browser = await initBrowser();
        const page = state.sharedPage;

        const INPUT_SELECTOR = "input[name='numberrange']";
        await page.waitForSelector(INPUT_SELECTOR, { state: 'visible', timeout: 10000 });
        await page.fill(INPUT_SELECTOR, prefix);

        const BUTTON_SELECTOR = "button:has-text('Get Number')";
        await page.waitForSelector(BUTTON_SELECTOR, { state: 'visible', timeout: 10000 });

        for (let i = 0; i < clickCount; i++) await page.click(BUTTON_SELECTOR, { force: true });

        let foundNumbers = [];
        const maxRounds = 2;
        for (let r = 0; r < maxRounds; r++) {
            foundNumbers = await getAllNumbersParallel(page, clickCount);
            if (foundNumbers.length >= clickCount) break;
            if (r === 1) await page.click(BUTTON_SELECTOR, { force: true });
            await new Promise(r => setTimeout(r, 5000));
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

        // Kirim hasil akhir
        let msg = `✅ The number is ready\n\n`;
        foundNumbers.slice(0, clickCount).forEach((entry, idx) => {
            msg += `📞 Number ${idx + 1} : <code>${entry.number}</code>\n`;
        });
        msg += `${emoji} COUNTRY : ${mainCountry}\n🏷️ Range   : <code>${prefix}</code>\n\n<b>🤖 Number available, waiting for OTP</b>\n`;

        const inlineKb = {
            inline_keyboard: [
                [{ text: "🔄 Change 1 Number", callback_data: `change_num:1:${prefix}` }],
                [{ text: "🔄 Change 3 Number", callback_data: `change_num:3:${prefix}` }],
                [{ text: "🔐 OTP Grup", url: config.GROUP_LINK_1 }, { text: "🌐 Change Range", callback_data: "getnum" }]
            ]
        };

        await tg.tgEdit(userId, msgId, msg, inlineKb);

    } catch (e) {
        if (msgId) {
            const text = e.name === 'TimeoutError'
                ? "❌ Timeout web. Web lambat atau tombol tidak ditemukan. Mohon coba lagi."
                : `❌ Terjadi kesalahan (${e.message}). Mohon coba lagi.`;
            await tg.tgEdit(userId, msgId, text);
        }
    } finally {
        if (actionInterval) clearInterval(actionInterval);
        release();
    }
}

module.exports = {
    initBrowser,
    processUserInput
};
