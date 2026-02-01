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

function getProgressMessage(currentStep, totalSteps, prefixRange, numCount) {
    const progressRatio = Math.min(currentStep / 12, 1.0);
    const filledCount = Math.ceil(progressRatio * config.BAR.MAX_LENGTH);
    const emptyCount = config.BAR.MAX_LENGTH - filledCount;
    const bar = config.BAR.FILLED.repeat(filledCount) + config.BAR.EMPTY.repeat(emptyCount);

    let status = config.STATUS_MAP[currentStep];
    if (!status) {
        if (currentStep < 3) status = config.STATUS_MAP[0];
        else if (currentStep < 5) status = config.STATUS_MAP[4];
        else if (currentStep < 8) status = config.STATUS_MAP[5];
        else if (currentStep < 12) status = config.STATUS_MAP[8];
        else status = config.STATUS_MAP[12];
    }

    return `<code>${status}</code>\n<blockquote>Range: <code>${prefixRange}</code> | Jumlah: <code>${numCount}</code></blockquote>\n<code>Load:</code> [${bar}]`;
}

// --- Browser Control ---

async function initBrowser() {
    if (state.browser) {
        try { await state.browser.close(); } catch(e){}
    }
    
    console.log("[BROWSER] Launching Chromium with Remote Debugging (Port 9222)...");
    state.browser = await chromium.launch({
        headless: config.HEADLESS,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--remote-debugging-port=9222', // Pintu masuk untuk range.js
            '--disable-dev-shm-usage'
        ]
    });

    const context = await state.browser.newContext();
    state.sharedPage = await context.newPage();

    try {
        await performLogin(state.sharedPage, config.STEX_EMAIL, config.STEX_PASSWORD, config.LOGIN_URL);
        console.log("[BROWSER] Login Success. Redirecting to GetNum...");
        await state.sharedPage.goto(config.TARGET_URL, { waitUntil: 'domcontentloaded' });
        console.log("[BROWSER] Ready on Target URL.");
    } catch (e) {
        console.error(`[BROWSER ERROR] Login Failed: ${e.message}`);
    }
}



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

        if (number && number.length > 5) return { number, country, status: statusText };
        return null;

    } catch (e) {
        return null;
    }
}

async function getAllNumbersParallel(page, numToFetch) {
    const tasks = [];
    for (let i = 1; i <= numToFetch + 5; i++) {
        tasks.push(getNumberAndCountryFromRow(`tbody tr:nth-child(${i})`, page));
    }
    const results = await Promise.all(tasks);
    
    const currentNumbers = [];
    const seen = new Set();
    
    for (const res of results) {
        if (res && res.number && !seen.has(res.number)) {
            currentNumbers.push(res);
            seen.add(res.number);
        }
    }
    return currentNumbers;
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
            msgId = await tg.tgSend(userId, getProgressMessage(0, 0, prefix, numToFetch));
            if (!msgId) return;
        } else {
            await tg.tgEdit(userId, msgId, getProgressMessage(0, 0, prefix, numToFetch));
        }
    }

    const release = await playwrightLock.acquire();
    try {
        actionInterval = await actionTask(userId);
        let currentStep = 0;
        const startOpTime = Date.now() / 1000;

        if (!msgId) {
            msgId = await tg.tgSend(userId, getProgressMessage(currentStep, 0, prefix, numToFetch));
            if (!msgId) return;
        }

        // Re-check Page
        if (!state.sharedPage || state.sharedPage.isClosed()) {
             await initBrowser();
        }

        const page = state.sharedPage;
        const INPUT_SELECTOR = "input[name='numberrange']";
        try {
            await page.waitForSelector(INPUT_SELECTOR, { state: 'visible', timeout: 10000 });
            await page.fill(INPUT_SELECTOR, "");
            await page.fill(INPUT_SELECTOR, prefix);
            
            currentStep = 1;
            await new Promise(r => setTimeout(r, 500));
            currentStep = 2;

            const BUTTON_SELECTOR = "button:has-text('Get Number')";
            await page.waitForSelector(BUTTON_SELECTOR, { state: 'visible', timeout: 10000 });

            for (let i = 0; i < clickCount; i++) {
                await page.click(BUTTON_SELECTOR, { force: true });
            }

            currentStep = 3;
            await tg.tgEdit(userId, msgId, getProgressMessage(currentStep, 0, prefix, numToFetch));

            await new Promise(r => setTimeout(r, 500));
            currentStep = 4;
            await tg.tgEdit(userId, msgId, getProgressMessage(currentStep, 0, prefix, numToFetch));

            await new Promise(r => setTimeout(r, 1000));

            const delayRound1 = 5.0;
            const delayRound2 = 5.0;
            const checkInterval = 0.25;
            let foundNumbers = [];

            const rounds = [delayRound1, delayRound2];

            for (let rIdx = 0; rIdx < rounds.length; rIdx++) {
                const duration = rounds[rIdx];
                if (rIdx === 0) currentStep = 5;
                else if (rIdx === 1) {
                    if (foundNumbers.length < numToFetch) {
                        await page.click(BUTTON_SELECTOR, { force: true });
                        await new Promise(r => setTimeout(r, 1500));
                        currentStep = 8;
                    }
                }

                const startTime = Date.now() / 1000;
                let lastCheck = 0;

                while ((Date.now() / 1000 - startTime) < duration) {
                    const now = Date.now() / 1000;
                    if (now - lastCheck >= checkInterval) {
                        foundNumbers = await getAllNumbersParallel(page, numToFetch);
                        lastCheck = now;
                        if (foundNumbers.length >= numToFetch) {
                            currentStep = 12;
                            break;
                        }
                    }

                    // Progress update
                    const elapsedTime = now - startOpTime;
                    const totalEstimated = delayRound1 + delayRound2 + 4;
                    const targetStep = Math.floor(12 * elapsedTime / totalEstimated);
                    if (targetStep > currentStep && targetStep <= 12) {
                        currentStep = targetStep;
                        await tg.tgEdit(userId, msgId, getProgressMessage(currentStep, 0, prefix, numToFetch));
                    }
                    await new Promise(r => setTimeout(r, 50));
                }
                if (foundNumbers.length >= numToFetch) break;
            }

            if (!foundNumbers || foundNumbers.length === 0) {
                await tg.tgEdit(userId, msgId, "❌ NOMOR TIDAK DI TEMUKAN. Coba lagi atau ganti range.");
                return;
            }

            const mainCountry = foundNumbers[0].country || "UNKNOWN";
            currentStep = 12;
            await tg.tgEdit(userId, msgId, getProgressMessage(currentStep, 0, prefix, numToFetch));

            // Save Cache & Waitlist
            foundNumbers.forEach(entry => {
                db.saveCache({ number: entry.number, country: entry.country, user_id: userId, time: Date.now() });
                db.addToWaitList(entry.number, userId, usernameTg, firstNameTg);
            });

            state.lastUsedRange[userId] = prefix;
            const emoji = config.COUNTRY_EMOJI[mainCountry] || "🏴‍☠️";
            
            let msg = "";
            if (numToFetch === 10) {
                msg = "✅The number is already.\n\n<code>";
                foundNumbers.slice(0, 10).forEach(entry => msg += `${entry.number}\n`);
                msg += "</code>";
            } else {
                msg = "✅ The number is ready\n\n";
                if (numToFetch === 1) {
                    msg += `📞 Number  : <code>${foundNumbers[0].number}</code>\n`;
                } else {
                    foundNumbers.slice(0, numToFetch).forEach((entry, idx) => {
                        msg += `📞 Number ${idx+1} : <code>${entry.number}</code>\n`;
                    });
                }
                msg += `${emoji} COUNTRY : ${mainCountry}\n` +
                       `🏷️ Range   : <code>${prefix}</code>\n\n` +
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
            if (e.name === 'TimeoutError') {
                if (msgId) await tg.tgEdit(userId, msgId, "❌ Timeout web. Web lambat atau tombol tidak ditemukan. Mohon coba lagi.");
            } else {
                if (msgId) await tg.tgEdit(userId, msgId, `❌ Terjadi kesalahan fatal (${e.message}). Mohon coba lagi.`);
            }
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
