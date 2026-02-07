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

// --- Browser Control (Optimized for VPS Speed) ---

async function initBrowser() {
    if (state.browser && state.browser.isConnected()) {
        return state.browser;
    }

    if (state.browser) {
        try { await state.browser.close(); } catch (e) {}
    }

    console.log("[BROWSER] Launching Ultra Fast Chromium...");
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
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const context = await state.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    state.sharedPage = await context.newPage();

    // Blokir asset berat agar loading secepat kilat
    await state.sharedPage.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,css}', route => {
        const type = route.request().resourceType();
        if (['image', 'font', 'stylesheet'].includes(type)) {
            route.abort();
        } else {
            route.continue();
        }
    });

    try {
        await performLogin(state.sharedPage, config.STEX_EMAIL, config.STEX_PASSWORD, config.LOGIN_URL);
        // Pakai 'commit' agar tidak menunggu network idle (lebih cepat)
        await state.sharedPage.goto(config.TARGET_URL, { waitUntil: 'commit' });
    } catch (e) {
        console.error(`[BROWSER ERROR] ${e.message}`);
    }
}

async function getAllNumbersParallel(page, numToFetch) {
    try {
        return await page.$$eval('tbody tr', (rows, targetCount) => {
            const results = [];
            for (const row of rows) {
                const phoneEl = row.querySelector('td:nth-child(1) span.font-mono');
                const statusEl = row.querySelector('td:nth-child(1) div:nth-child(2) span');
                const countryEl = row.querySelector('td:nth-child(2) span.text-slate-200');
                
                if (phoneEl) {
                    const statusText = statusEl ? statusEl.innerText.trim().toLowerCase() : "";
                    // Lewati yang sudah sukses/failed
                    if (statusText.includes("success") || statusText.includes("failed")) continue;

                    results.push({
                        numberRaw: phoneEl.innerText.trim(),
                        statusText: statusText,
                        country: countryEl ? countryEl.innerText.trim().toUpperCase() : "UNKNOWN"
                    });
                }
                if (results.length >= targetCount + 5) break;
            }
            return results;
        }, numToFetch);
    } catch (e) {
        return [];
    }
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

    const release = await playwrightLock.acquire();
    
    try {
        actionInterval = await actionTask(userId);
        
        // --- PESAN STATUS BARU (TANPA PROGRESS BAR) ---
        const statusText = `<i>Menunggu di antrian sistem aktif...</i>\n\n` +
                           `<blockquote>Range: <code>${prefix}</code> | Jumlah: <code>${numToFetch}</code></blockquote>\n` +
                           `note: <i>please wait...</i>`;

        if (!msgId) {
            msgId = await tg.tgSend(userId, statusText);
            if (!msgId) return;
        } else {
            await tg.tgEdit(userId, msgId, statusText);
        }

        // Init Browser jika diperlukan
        if (!state.sharedPage || state.sharedPage.isClosed() || !state.browser?.isConnected()) {
            await initBrowser();
        }

        const page = state.sharedPage;
        const INPUT_SELECTOR = "input[name='numberrange']";
        const BUTTON_SELECTOR = "button:has-text('Get Number')";

        // Manipulasi DOM Langsung
        await page.waitForSelector(INPUT_SELECTOR, { timeout: 10000 });
        await page.fill(INPUT_SELECTOR, prefix);
        
        // Klik tombol (Parallel)
        const clickPromises = [];
        for (let i = 0; i < clickCount; i++) {
            clickPromises.push(page.click(BUTTON_SELECTOR, { force: true }));
        }
        await Promise.all(clickPromises);

        // --- POLLING AGRESIF (Cek setiap 300ms) ---
        let foundNumbers = [];
        const maxWaitTime = 12000; // Max 12 detik cari nomor
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            const rawResults = await getAllNumbersParallel(page, numToFetch);
            
            // Filter nomor yang sudah ada di cache
            foundNumbers = rawResults
                .map(res => ({
                    ...res,
                    number: normalizeNumber(res.numberRaw)
                }))
                .filter(res => !db.isInCache(res.number));

            if (foundNumbers.length >= numToFetch) break;
            
            // Tunggu sebentar sebelum cek lagi
            await new Promise(r => setTimeout(r, 300));
            
            // Opsional: Klik lagi jika setelah 5 detik belum dapat sama sekali
            if (Date.now() - startTime > 5000 && foundNumbers.length === 0) {
                await page.click(BUTTON_SELECTOR, { force: true });
            }
        }

        if (foundNumbers.length === 0) {
            await tg.tgEdit(userId, msgId, "❌ NOMOR TIDAK DI TEMUKAN. Coba lagi atau ganti range.");
            return;
        }

        // Finalisasi Data
        const finalNumbers = foundNumbers.slice(0, numToFetch);
        const mainCountry = finalNumbers[0].country || "UNKNOWN";

        finalNumbers.forEach(entry => {
            db.saveCache({ number: entry.number, country: entry.country, user_id: userId, time: Date.now() });
            db.addToWaitList(entry.number, userId, usernameTg, firstNameTg);
        });

        state.lastUsedRange[userId] = prefix;
        const emoji = config.COUNTRY_EMOJI[mainCountry] || "🏴‍☠️";
        
        // --- UI Message Formatting (Fitur Lama Tetap Ada) ---
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
        console.error(`[FATAL ERROR] ${e.message}`);
        if (msgId) await tg.tgEdit(userId, msgId, `❌ Terjadi kesalahan: ${e.message}`);
    } finally {
        if (actionInterval) clearInterval(actionInterval);
        release();
    }
}

module.exports = {
    initBrowser,
    processUserInput
};
