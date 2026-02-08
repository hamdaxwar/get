// main.js
const cron = require('node-cron');
const config = require('./config');
const db = require('./helpers/database');
const tg = require('./helpers/telegram');
const scraper = require('./helpers/scraper');
const { state, playwrightLock } = require('./helpers/state');
const commands = require('./handlers/commands');
const callbacks = require('./handlers/callbacks');

console.log("[INFO] NodeJS Bot Starting...");

// --- Monitor Kadaluarsa Waitlist ---
async function expiryMonitorTask() {
    setInterval(async () => {
        try {
            const waitList = db.loadWaitList();
            const now = Date.now() / 1000;
            const updatedList = [];

            for (const item of waitList) {
                if (item.otp_received_time) {
                    updatedList.push(item);
                    continue;
                }

                if (now - item.timestamp > 1200) { // 20 menit
                    const msgId = await tg.tgSend(item.user_id, `⚠️ Nomor <code>${item.number}</code> telah kadaluarsa.`);
                    if (msgId) setTimeout(() => tg.tgDelete(item.user_id, msgId), 30000);
                } else {
                    updatedList.push(item);
                }
            }

            db.saveWaitList(updatedList);
        } catch (e) {
            console.error(`[MONITOR ERROR] ${e.message}`);
        }
    }, 15000);
}

// --- Polling Telegram ---
async function telegramLoop() {
    state.verifiedUsers = db.loadUsers();
    let offset = 0;

    // Bersihkan update lama
    try { await tg.tgGetUpdates(-1); } catch {}

    console.log("[TELEGRAM] Polling started...");

    while (true) {
        try {
            const updates = await tg.tgGetUpdates(offset);
            if (updates && updates.result) {
                for (const upd of updates.result) {
                    offset = upd.update_id + 1;

                    // Pesan biasa / command
                    if (upd.message) await commands.processCommand(upd.message);

                    // Callback tombol inline
                    if (upd.callback_query) await callbacks.processCallback(upd.callback_query);
                }
            }
        } catch (e) {
            if (e.response && e.response.status === 429) {
                const retryAfter = (e.response.data.parameters?.retry_after || 10) * 1000;
                console.log(`[WARNING] Telegram Rate Limit. Waiting ${retryAfter/1000}s...`);
                await new Promise(r => setTimeout(r, retryAfter));
            } else {
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        // Delay polling agar tidak kena 429
        await new Promise(r => setTimeout(r, 1000));
    }
}

// --- MAIN FUNCTION ---
async function main() {
    try {
        // 1. Init database
        db.initializeFiles();

        // 2. Start internal monitors
        require('./range.js');
        require('./message.js');
        require('./sms.js');

        // 3. Cron Job: refresh browser tiap jam 07:00 WIB
        cron.schedule('0 7 * * *', async () => {
            console.log("[CRON] Refreshing Browser Session...");
            const release = await playwrightLock.acquire();
            try { await scraper.initBrowser(); }
            catch (e) { console.error(`[CRON ERROR] ${e.message}`); }
            finally { release(); }
        }, { scheduled: true, timezone: "Asia/Jakarta" });

        // 4. Init browser awal
        await scraper.initBrowser();

        // 5. Jalankan polling Telegram dan monitor expiry paralel
        await Promise.all([
            telegramLoop(),
            expiryMonitorTask()
        ]);

    } catch (e) {
        console.error(`[FATAL ERROR] ${e.message}`);
    }
}

main();
