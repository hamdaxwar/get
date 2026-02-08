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
            '--single-process'
        ]
    });

    // Berikan izin CLIPBOARD agar navigator.clipboard.readText() bisa bekerja
    const context = await state.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        permissions: ['clipboard-read', 'clipboard-write'] 
    });

    state.sharedPage = await context.newPage();

    // Blokir resource berat
    await state.sharedPage.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', route => route.abort());

    try {
        await performLogin(state.sharedPage, config.STEX_EMAIL, config.STEX_PASSWORD, config.LOGIN_URL);
        console.log("[BROWSER] Login Success. Redirecting to GetNum...");
        await state.sharedPage.goto(config.TARGET_URL, { waitUntil: 'domcontentloaded' });
    } catch (e) {
        console.error(`[BROWSER ERROR] Login/Redirect Failed: ${e.message}`);
    }
}

// Mengambil data via Clipboard (Jauh lebih cepat dari scraping DOM)
async function getNumberFromClipboard(page) {
    try {
        // Eksekusi script di dalam browser untuk membaca clipboard
        const clipboardContent = await page.evaluate(async () => {
            try {
                return await navigator.clipboard.readText();
            } catch (err) {
                return null;
            }
        });

        if (!clipboardContent) return null;

        const number = clipboardContent.replace(/[\s-]/g, "");
        const normalized = number.startsWith('+') ? number : '+' + number;

        // Validasi simpel apakah isi clipboard itu benar nomor telepon
        if (/^\+\d{7,15}$/.test(normalized)) {
            return normalized;
        }
        return null;
    } catch (e) {
        return null;
    }
}

// Fallback: Tetap simpan fungsi lama jika clipboard gagal/kosong
async function getAllNumbersParallel(page, numToFetch) {
    try {
        const rowsData = await page.$$eval('tbody tr', (rows) => {
            return rows.map(row => {
                const phoneEl = row.querySelector('td:nth-child(1) span.font-mono');
                const countryEl = row.querySelector('td:nth-child(2) span.text-slate-200');
                return {
                    numberRaw: phoneEl ? phoneEl.innerText.trim() : null,
                    country: countryEl ? countryEl.innerText.trim().toUpperCase() : "UNKNOWN"
                };
            });
        });

        const currentNumbers = [];
        for (const res of rowsData) {
            if (!res.numberRaw) continue;
            const normalized = normalizeNumber(res.numberRaw);
            if (db.isInCache(normalized)) continue;
            currentNumbers.push({ number: normalized, country: res.country });
            if (currentNumbers.length >= numToFetch) break;
        }
        return currentNumbers;
    } catch (e) { return []; }
}

// --- Main Action Logic ---

async function actionTask(userId) {
    return setInterval(() => {
        tg.tgSendAction(userId, "typing");
    }, 4500);
}

async function processUserInput(userId, prefix, clickCount, usernameTg, firstNameTg, messageIdToEdit = null) {
    let msgId = messageIdToEdit || state.pendingMessage[userId];
    let actionInterval = null;
    const numToFetch = clickCount;

    // --- OPTIMASI ANTREAN: Cek dulu baru kirim pesan ---
    const isWaitNeeded = playwrightLock.isLocked();
    if (isWaitNeeded) {
        const waitMsg = getProgressMessage(0, 0, prefix, numToFetch);
        if (!msgId) msgId = await tg.tgSend(userId, waitMsg);
        else await tg.tgEdit(userId, msgId, waitMsg);
    }

    const release = await playwrightLock.acquire();
    
    try {
        actionInterval = await actionTask(userId);
        let currentStep = 0;
        const startOpTime = Date.now() / 1000;

        // Jika tidak antri, kirim pesan awal sekarang
        if (!msgId) {
            msgId = await tg.tgSend(userId, getProgressMessage(currentStep, 0, prefix, numToFetch));
        }

        if (!state.sharedPage || state.sharedPage.isClosed() || !state.browser.isConnected()) {
            await initBrowser();
        }

        const page = state.sharedPage;
        const INPUT_SELECTOR = "input[name='numberrange']";
        const BUTTON_SELECTOR = "button:has-text('Get Number')";

        // Step 1: Input
        await page.waitForSelector(INPUT_SELECTOR, { state: 'visible', timeout: 10000 });
        await page.fill(INPUT_SELECTOR, "");
        await page.fill(INPUT_SELECTOR, prefix);
        currentStep = 1;
        
        // Step 2: Click & Clipboard Capture
        currentStep = 2;
        let foundNumbers = [];
        const seenInThisSession = new Set();

        for (let i = 0; i < clickCount; i++) {
            await page.click(BUTTON_SELECTOR, { force: true });
            
            // Tunggu sebentar agar clipboard terisi oleh web
            await new Promise(r => setTimeout(r, 400)); 
            
            const num = await getNumberFromClipboard(page);
            if (num && !db.isInCache(num) && !seenInThisSession.has(num)) {
                foundNumbers.push({ number: num, country: "DETECTING..." });
                seenInThisSession.add(num);
            }
            
            // Update Progress UI setiap klik
            currentStep = Math.min(3 + i, 11);
            await tg.tgEdit(userId, msgId, getProgressMessage(currentStep, 0, prefix, numToFetch));
        }

        // Jika clipboard gagal/kosong, gunakan metode scraping sebagai backup
        if (foundNumbers.length < numToFetch) {
            const backupNums = await getAllNumbersParallel(page, numToFetch);
            backupNums.forEach(bn => {
                if (!seenInThisSession.has(bn.number)) {
                    foundNumbers.push(bn);
                    seenInThisSession.add(bn.number);
                }
            });
        }

        if (foundNumbers.length === 0) {
            await tg.tgEdit(userId, msgId, "❌ NOMOR TIDAK DI TEMUKAN. Coba lagi atau ganti range.");
            return;
        }

        // Finalisasi data
        const finalNumbers = foundNumbers.slice(0, numToFetch);
        const mainCountry = finalNumbers[0].country !== "DETECTING..." ? finalNumbers[0].country : "UNKNOWN";
        
        currentStep = 12;
        await tg.tgEdit(userId, msgId, getProgressMessage(currentStep, 0, prefix, numToFetch));

        // Save ke Cache & DB
        finalNumbers.forEach(entry => {
            db.saveCache({ number: entry.number, country: entry.country, user_id: userId, time: Date.now() });
            db.addToWaitList(entry.number, userId, usernameTg, firstNameTg);
        });

        state.lastUsedRange[userId] = prefix;
        const emoji = config.COUNTRY_EMOJI[mainCountry] || "🏳️";
        
        // --- UI Message (Fitur Lama Tetap Ada) ---
        let msg = "";
        if (numToFetch === 10) {
            msg = "✅The number is already.\n\n<code>";
            finalNumbers.forEach(entry => msg += `${entry.number}\n`);
            msg += "</code>";
        } else {
            msg = "✅ The number is ready\n\n";
            if (numToFetch === 1) {
                msg += `📞 Number : <code>${finalNumbers[0].number}</code>\n`;
            } else {
                finalNumbers.forEach((entry, idx) => {
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
        if (msgId) await tg.tgEdit(userId, msgId, `❌ Terjadi kesalahan: ${e.message}`);
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
