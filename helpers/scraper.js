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

// [OPTIMASI TAMPILAN] Menggunakan Static Message agar API Telegram tidak limit & proses lebih cepat
function getProgressMessage(prefixRange, numCount) {
    return `<i>Menunggu di antrian sistem aktif...</i>\n\n` +
           `<blockquote>Range: <code>${prefixRange}</code> | Jumlah: <code>${numCount}</code></blockquote>\n` +
           `note: <i>please wait...</i>`;
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
            '--disable-dev-shm-usage', // Mengatasi crash memori di VPS
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

// [OPTIMASI KECEPATAN] Mengambil & Membersihkan data langsung di dalam Engine Browser
async function getAllNumbersParallel(page, numToFetch) {
    try {
        // Eksekusi logic berat di sisi browser (C++) bukan Node.js
        const rowsData = await page.$$eval('tbody tr', (rows) => {
            return rows.map(row => {
                const phoneEl = row.querySelector('td:nth-child(1) span.font-mono');
                const statusEl = row.querySelector('td:nth-child(1) div:nth-child(2) span');
                const countryEl = row.querySelector('td:nth-child(2) span.text-slate-200');
                
                if (!phoneEl) return null;

                const rawNum = phoneEl.innerText;
                // Pre-cleaning di browser (lebih cepat)
                const cleanNum = rawNum.replace(/[\s-]/g, ""); 
                const status = statusEl ? statusEl.innerText.toLowerCase() : "unknown";
                
                return {
                    n: cleanNum.startsWith('+') ? cleanNum : '+' + cleanNum, // n = number
                    s: status, // s = status
                    c: countryEl ? countryEl.innerText.toUpperCase() : "UNKNOWN" // c = country
                };
            });
        });

        const currentNumbers = [];
        const seen = new Set();

        for (const res of rowsData) {
            if (!res) continue;
            
            // Filter validasi
            if (res.s.includes("success") || res.s.includes("failed")) continue;
            
            // Cek Cache Database
            if (db.isInCache(res.n)) continue; 
            
            if (!seen.has(res.n)) {
                currentNumbers.push({ number: res.n, country: res.c, status: res.s });
                seen.add(res.n);
            }
            // Short-circuit jika kuota terpenuhi
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

    // --- Handle Lock & Initial Message ---
    if (playwrightLock.isLocked()) {
        if (!msgId) {
            msgId = await tg.tgSend(userId, getProgressMessage(prefix, numToFetch));
            if (!msgId) return;
        } else {
            await tg.tgEdit(userId, msgId, getProgressMessage(prefix, numToFetch));
        }
    }

    const release = await playwrightLock.acquire();
    
    try {
        actionInterval = await actionTask(userId);
        
        // Pastikan User mendapat respon awal "Menunggu..."
        if (!msgId) {
            msgId = await tg.tgSend(userId, getProgressMessage(prefix, numToFetch));
            if (!msgId) return;
        } else {
            // Edit sekali saja di awal
            await tg.tgEdit(userId, msgId, getProgressMessage(prefix, numToFetch));
        }

        // Re-check/Init Browser
        if (!state.sharedPage || state.sharedPage.isClosed() || !state.browser.isConnected()) {
            await initBrowser();
        }

        const page = state.sharedPage;
        const INPUT_SELECTOR = "input[name='numberrange']";
        const BUTTON_SELECTOR = "button:has-text('Get Number')";

        // --- STEP 1: INPUT & CLICK (DIPERCEPAT) ---
        try {
            await page.waitForSelector(INPUT_SELECTOR, { state: 'visible', timeout: 5000 });
            await page.fill(INPUT_SELECTOR, "");
            await page.fill(INPUT_SELECTOR, prefix);
            
            // Tunggu tombol siap
            await page.waitForSelector(BUTTON_SELECTOR, { state: 'visible', timeout: 5000 });
            
            // Klik Barbar (Cepat)
            for (let i = 0; i < clickCount; i++) {
                // 'noWaitAfter: true' membuat script tidak menunggu page load selesai -> INSTANT
                page.click(BUTTON_SELECTOR, { force: true, noWaitAfter: true }).catch(() => {});
            }
        } catch (err) {
            console.log("Input/Click error (minor):", err.message);
        }
        
        // --- STEP 2: MONITORING (LOOP CEPAT / AGGRESIVE POLLING) ---
        const maxDuration = 15.0; // Maksimal waktu mencari (detik)
        const startTime = Date.now();
        const pollingRate = 100; // Cek setiap 100ms (Sangat Cepat)
        
        let foundNumbers = [];
        let isReClicked = false;

        // Loop "While" lebih efisien daripada loop bertingkat untuk polling
        while ((Date.now() - startTime) < (maxDuration * 1000)) {
            // 1. Ambil Data
            foundNumbers = await getAllNumbersParallel(page, numToFetch);

            // 2. Cek Kondisi Berhenti
            if (foundNumbers.length >= numToFetch) {
                break; // SELESAI
            }

            // 3. Logic Re-Click (Backup jika klik awal tidak respon)
            // Jika sudah 3 detik berjalan tapi belum dapat hasil, klik lagi
            if (!isReClicked && (Date.now() - startTime) > 3000) {
                console.log("[LOGIC] Re-clicking button for assurance...");
                page.click(BUTTON_SELECTOR, { force: true, noWaitAfter: true }).catch(() => {});
                isReClicked = true;
            }

            // 4. Jeda super singkat (Non-blocking)
            await new Promise(r => setTimeout(r, pollingRate));
        }

        // --- STEP 3: HASIL & DATABASE ---

        if (!foundNumbers || foundNumbers.length === 0) {
            await tg.tgEdit(userId, msgId, "❌ NOMOR TIDAK DI TEMUKAN. Coba lagi atau ganti range.");
            return;
        }

        const mainCountry = foundNumbers[0].country || "UNKNOWN";

        // Simpan ke Cache & Waitlist Database
        foundNumbers.forEach(entry => {
            db.saveCache({ number: entry.number, country: entry.country, user_id: userId, time: Date.now() });
            db.addToWaitList(entry.number, userId, usernameTg, firstNameTg);
        });

        state.lastUsedRange[userId] = prefix;
        const emoji = config.COUNTRY_EMOJI[mainCountry] || "🏴‍☠️";
        
        // --- UI Message Formatting (Sesuai Fitur Lama) ---
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

        // --- Inline Keyboard (Fitur Lama Tetap Ada) ---
        const inlineKb = {
            inline_keyboard: [
                [{ text: "🔄 Change 1 Number", callback_data: `change_num:1:${prefix}` }],
                [{ text: "🔄 Change 3 Number", callback_data: `change_num:3:${prefix}` }],
                [{ text: "🔐 OTP Grup", url: config.GROUP_LINK_1 }, { text: "🌐 Change Range", callback_data: "getnum" }]
            ]
        };

        // Edit pesan terakhir dengan hasil
        await tg.tgEdit(userId, msgId, msg, inlineKb);

    } catch (e) {
        console.error(`[PROCESS ERROR] ${e.message}`);
        if (msgId) await tg.tgEdit(userId, msgId, `❌ Terjadi kesalahan (${e.message}). Mohon coba lagi.`);
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
