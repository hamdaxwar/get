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

function getProgressMessage(prefixRange, numCount) {
    return `<i>Menunggu di antrian sistem aktif...</i>\n\n` +
           `<blockquote>Range: <code>${prefixRange}</code> | Jumlah: <code>${numCount}</code></blockquote>\n` +
           `note: <i>please wait...</i>`;
}

// --- Browser Control (Optimized for VPS) ---

async function initBrowser() {
    if (state.browser && state.browser.isConnected()) {
        return state.browser;
    }

    if (state.browser) {
        try { await state.browser.close(); } catch (e) {}
    }

    console.log("[BROWSER] Launching Optimized Chromium...");
    state.browser = await chromium.launch({
        headless: config.HEADLESS,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            '--disable-extensions'
        ]
    });

    const context = await state.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    state.sharedPage = await context.newPage();
    await state.sharedPage.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', route => route.abort());

    try {
        await performLogin(state.sharedPage, config.STEX_EMAIL, config.STEX_PASSWORD, config.LOGIN_URL);
        console.log("[BROWSER] Login Success. Redirecting to GetNum...");
        await state.sharedPage.goto(config.TARGET_URL, { waitUntil: 'domcontentloaded' });
        console.log("[BROWSER] Ready on Target URL.");
    } catch (e) {
        console.error(`[BROWSER ERROR] Login/Redirect Failed: ${e.message}`);
    }
}

// [OPTIMASI] Hanya mengambil nomor dengan tag "Just Now"
async function getAllNumbersParallel(page, numToFetch) {
    try {
        const rowsData = await page.$$eval('tbody tr', (rows) => {
            return rows.map(row => {
                const phoneEl = row.querySelector('td:nth-child(1) span.font-mono');
                const statusEl = row.querySelector('td:nth-child(1) div:nth-child(2) span');
                const countryEl = row.querySelector('td:nth-child(2) span.text-slate-200');
                const timeEl = row.querySelector('td:nth-child(3) span'); // Kolom waktu
                
                if (!phoneEl || !timeEl) return null;

                const timeText = timeEl.innerText.trim();
                const status = statusEl ? statusEl.innerText.toLowerCase() : "unknown";

                // FILTER: Hanya ambil yang "Just Now"
                if (timeText !== "Just Now") return null;
                
                // FILTER: Abaikan jika sudah selesai/gagal
                if (status.includes("success") || status.includes("failed")) return null;

                const rawNum = phoneEl.innerText;
                const cleanNum = rawNum.replace(/[\s-]/g, ""); 
                
                return {
                    n: cleanNum.startsWith('+') ? cleanNum : '+' + cleanNum,
                    s: status,
                    c: countryEl ? countryEl.innerText.toUpperCase() : "UNKNOWN"
                };
            });
        });

        const currentNumbers = [];
        const seen = new Set();

        for (const res of rowsData) {
            if (!res) continue;
            if (db.isInCache(res.n)) continue; 
            
            if (!seen.has(res.n)) {
                currentNumbers.push({ number: res.n, country: res.c, status: res.s });
                seen.add(res.n);
            }
            if (currentNumbers.length >= numToFetch) break;
        }
        return currentNumbers;
    } catch (e) {
        return [];
    }
}

// --- Main Action Logic ---

async function actionTask(userId) {
    const interval = setInterval(() => {
        tg.tgSendAction(userId, "typing");
    }, 4500);
    return interval;
}

async function processUserInput(userId, prefix, clickCount, usernameTg, firstNameTg, messageIdToEdit = null) {
    let msgId = messageIdToEdit || state.pendingMessage[userId];
    let actionInterval = null;
    const numToFetch = clickCount;

    if (playwrightLock.isLocked()) {
        if (!msgId) {
            msgId = await tg.tgSend(userId, getProgressMessage(prefix, numToFetch));
        } else {
            await tg.tgEdit(userId, msgId, getProgressMessage(prefix, numToFetch));
        }
    }

    const release = await playwrightLock.acquire();
    
    try {
        actionInterval = await actionTask(userId);
        
        if (!msgId) {
            msgId = await tg.tgSend(userId, getProgressMessage(prefix, numToFetch));
        } else {
            await tg.tgEdit(userId, msgId, getProgressMessage(prefix, numToFetch));
        }

        if (!state.sharedPage || state.sharedPage.isClosed() || !state.browser.isConnected()) {
            await initBrowser();
        }

        const page = state.sharedPage;
        const INPUT_SELECTOR = "input[name='numberrange']";
        const BUTTON_SELECTOR = "button:has-text('Get Number')";

        try {
            await page.waitForSelector(INPUT_SELECTOR, { state: 'visible', timeout: 5000 });
            await page.fill(INPUT_SELECTOR, "");
            await page.fill(INPUT_SELECTOR, prefix);
            await page.waitForSelector(BUTTON_SELECTOR, { state: 'visible', timeout: 5000 });
            
            for (let i = 0; i < clickCount; i++) {
                page.click(BUTTON_SELECTOR, { force: true, noWaitAfter: true }).catch(() => {});
            }
        } catch (err) {
            console.log("Input/Click error:", err.message);
        }
        
        const maxDuration = 15.0; 
        const startTime = Date.now();
        const pollingRate = 150; 
        
        let foundNumbers = [];
        let isReClicked = false;

        while ((Date.now() - startTime) < (maxDuration * 1000)) {
            foundNumbers = await getAllNumbersParallel(page, numToFetch);

            if (foundNumbers.length >= numToFetch) break;

            if (!isReClicked && (Date.now() - startTime) > 4000) {
                page.click(BUTTON_SELECTOR, { force: true, noWaitAfter: true }).catch(() => {});
                isReClicked = true;
            }

            await new Promise(r => setTimeout(r, pollingRate));
        }

        if (!foundNumbers || foundNumbers.length === 0) {
            await tg.tgEdit(userId, msgId, "❌ NOMOR TIDAK DITEMUKAN (Atau tidak ada yang 'Just Now'). Coba lagi.");
            return;
        }

        const mainCountry = foundNumbers[0].country || "UNKNOWN";

        foundNumbers.forEach(entry => {
            db.saveCache({ number: entry.number, country: entry.country, user_id: userId, time: Date.now() });
            db.addToWaitList(entry.number, userId, usernameTg, firstNameTg);
        });

        state.lastUsedRange[userId] = prefix;
        const emoji = config.COUNTRY_EMOJI[mainCountry] || "🏴‍☠️";
        
        let msg = "";
        if (numToFetch === 10) {
            msg = "✅ The number is ready\n\n<code>";
            foundNumbers.slice(0, 10).forEach(entry => msg += `${entry.number}\n`);
            msg += "</code>";
        } else {
            msg = "✅ The number is ready\n\n";
            if (numToFetch === 1) {
                msg += `📞 Number : <code>${foundNumbers[0].number}</code>\n`;
            } else {
                foundNumbers.slice(0, numToFetch).forEach((entry, idx) => {
                    msg += `📞 Number ${idx + 1} : <code>${entry.number}</code>\n`;
                });
            }
            msg += `${emoji} COUNTRY : ${mainCountry}\n` +
                   `🏷️ Range : <code>${prefix}</code>\n\n` +
                   `<b>🤖 Number available please use, Waiting for OTP</b>\n`;
        }

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
        if (msgId) await tg.tgEdit(userId, msgId, `❌ Terjadi kesalahan (${e.message}).`);
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
