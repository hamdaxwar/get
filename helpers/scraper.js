Const { chromium } = require('playwright');
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

// --- Browser Control (Optimized for VPS) ---

async function initBrowser() {
    // Reuse browser jika masih konek untuk menghemat RAM
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
            '--remote-debugging-port=9222',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            '--disable-extensions'
        ]
    });

    const context = await state.browser.newContext({
        // Gunakan User Agent asli agar tidak terdeteksi bot
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    state.sharedPage = await context.newPage();

    // Blokir beban berat seperti gambar dan font agar loading cepat & hemat RAM
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

// Mengambil banyak data baris sekaligus (Optimasi CPU)
async function getAllNumbersParallel(page, numToFetch) {
    try {
        // Eksekusi di dalam konteks browser untuk kecepatan maksimal
        const rowsData = await page.$$eval('tbody tr', (rows) => {
            return rows.map(row => {
                const phoneEl = row.querySelector('td:nth-child(1) span.font-mono');
                const statusEl = row.querySelector('td:nth-child(1) div:nth-child(2) span');
                const countryEl = row.querySelector('td:nth-child(2) span.text-slate-200');
                
                return {
                    numberRaw: phoneEl ? phoneEl.innerText.trim() : null,
                    statusText: statusEl ? statusEl.innerText.trim().toLowerCase() : "unknown",
                    country: countryEl ? countryEl.innerText.trim().toUpperCase() : "UNKNOWN"
                };
            });
        });

        const currentNumbers = [];
        const seen = new Set();

        for (const res of rowsData) {
            if (!res.numberRaw) continue;
            
            const number = res.numberRaw.replace(/[\s-]/g, "");
            const normalized = number.startsWith('+') ? number : '+' + number;

            // Filter validasi
            if (db.isInCache(normalized)) continue;
            if (res.statusText.includes("success") || res.statusText.includes("failed")) continue;
            
            if (!seen.has(normalized)) {
                currentNumbers.push({ number: normalized, country: res.country, status: res.statusText });
                seen.add(normalized);
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

    // Handle Lock & Initial Message
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

        // Re-check/Init Browser
        if (!state.sharedPage || state.sharedPage.isClosed() || !state.browser.isConnected()) {
            await initBrowser();
        }

        const page = state.sharedPage;
        const INPUT_SELECTOR = "input[name='numberrange']";

        // Step 1: Input Range
        await page.waitForSelector(INPUT_SELECTOR, { state: 'visible', timeout: 10000 });
        await page.fill(INPUT_SELECTOR, "");
        await page.fill(INPUT_SELECTOR, prefix);
        currentStep = 1;
        await new Promise(r => setTimeout(r, 500));
        
        // Step 2: Trigger Clicks
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

        // Step 3: Monitoring & Retrieval
        const delayRound1 = 5.0;
        const delayRound2 = 5.0;
        const checkInterval = 0.5; // Ditingkatkan sedikit agar tidak terlalu sering hit DOM VPS
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

                // Update UI Progress Bar secara dinamis
                const elapsedTime = now - startOpTime;
                const totalEstimated = delayRound1 + delayRound2 + 4;
                const targetStep = Math.floor(12 * elapsedTime / totalEstimated);
                
                if (targetStep > currentStep && targetStep <= 12) {
                    currentStep = targetStep;
                    await tg.tgEdit(userId, msgId, getProgressMessage(currentStep, 0, prefix, numToFetch));
                }
                await new Promise(r => setTimeout(r, 100));
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

        // Save ke Cache & Waitlist Database
        foundNumbers.forEach(entry => {
            db.saveCache({ number: entry.number, country: entry.country, user_id: userId, time: Date.now() });
            db.addToWaitList(entry.number, userId, usernameTg, firstNameTg);
        });

        state.lastUsedRange[userId] = prefix;
        const emoji = config.COUNTRY_EMOJI[mainCountry] || "🏴‍☠️";
        
        // --- UI Message Formatting (Tetap Sesuai Fitur Lama) ---
        let msg = "";
        if (numToFetch === 10) {
            msg = "✅The number is already.\n\n<code>";
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

        // --- Inline Keyboard (Fitur Change 1 & 3 Tetap Ada) ---
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
            if (msgId) await tg.tgEdit(userId, msgId, "❌ Timeout web. Web lambat atau tombol tidak ditemukan. Mohon coba lagi.");
        } else {
            if (msgId) await tg.tgEdit(userId, msgId, `❌ Terjadi kesalahan fatal (${e.message}). Mohon coba lagi.`);
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
