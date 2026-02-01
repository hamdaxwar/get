const { fork } = require('child_process');
const cron = require('node-cron');
const config = require('./config');
const db = require('./helpers/database');
const tg = require('./helpers/telegram');
const scraper = require('./helpers/scraper');
const { state, playwrightLock } = require('./helpers/state');
const commands = require('./handlers/commands');
const callbacks = require('./handlers/callbacks');

// --- Background Task: Expiry Monitor ---
async function expiryMonitorTask() {
    setInterval(async () => {
        try {
            const waitList = db.loadWaitList();
            const now = Date.now() / 1000;
            const updatedList = [];
            for (const item of waitList) {
                if (now - item.timestamp > 1200) { // 20 Menit
                    const msgId = await tg.tgSend(item.user_id, `⚠️ Nomor <code>${item.number}</code> telah kadaluarsa.`);
                    if (msgId) {
                        setTimeout(() => tg.tgDelete(item.user_id, msgId), 30000);
                    }
                } else {
                    updatedList.push(item);
                }
            }
            db.saveWaitList(updatedList);
        } catch (e) { /* ignore */ }
    }, 10000);
}

// --- Telegram Polling Loop ---
async function telegramLoop() {
    state.verifiedUsers = db.loadUsers();
    let offset = 0;

    // Bersihkan update lama
    await tg.tgGetUpdates(-1);
    console.log("[TELEGRAM] Polling started...");

    while (true) {
        const data = await tg.tgGetUpdates(offset);
        if (data && data.result) {
            for (const upd of data.result) {
                offset = upd.update_id + 1;
                
                // Handle Messages
                if (upd.message) {
                    await commands.processCommand(upd.message);
                }

                // Handle Callbacks
                if (upd.callback_query) {
                    await callbacks.processCallback(upd.callback_query);
                }
            }
        }
        await new Promise(r => setTimeout(r, 50));
    }
}

// --- MAIN FUNCTION ---
async function main() {
    console.log("[INFO] Starting NodeJS Bot (Refactored)...");
    
    // 1. Init Files
    db.initializeFiles();
    
    // 2. Start Internal Monitors (Shared Memory)
    console.log("[INFO] Loading Range & Message Monitors internally...");
    require('./range.js'); 
    require('./message.js'); 

    // 3. Cron Job: Restart Browser (07:00 WIB)
    cron.schedule('0 7 * * *', async () => {
        console.log("[CRON] Refreshing Browser Session (07:00 WIB)...");
        const release = await playwrightLock.acquire();
        try {
            await scraper.initBrowser();
        } catch (e) {
            console.error("[CRON ERROR]", e);
        } finally {
            release();
        }
    }, {
        scheduled: true,
        timezone: "Asia/Jakarta"
    });

    // 4. Start Browser & Loops
    try {
        // Init browser akan mengisi state.browser
        await scraper.initBrowser();
        
        await Promise.all([
            telegramLoop(),
            expiryMonitorTask()
        ]);
    } catch (e) {
        console.error("[FATAL ERROR]", e);
    }
}

main();
