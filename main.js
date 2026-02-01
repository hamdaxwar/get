const { fork } = require('child_process');
const cron = require('node-cron');
const config = require('./config');
const db = require('./helpers/database');
const tg = require('./helpers/telegram');
const scraper = require('./helpers/scraper');
const { state, playwrightLock } = require('./helpers/state');
const commands = require('./handlers/commands');
const callbacks = require('./handlers/callbacks');

// --- Background Task: Monitor Kadaluarsa ---
async function expiryMonitorTask() {
    setInterval(async () => {
        try {
            const waitList = db.loadWaitList();
            const now = Date.now() / 1000;
            const updatedList = [];
            for (const item of waitList) {
                // Jangan hapus jika nomor baru saja menerima OTP (status extended wait)
                if (item.otp_received_time) {
                    updatedList.push(item);
                    continue;
                }

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

    // Bersihkan update lama agar tidak double respond saat restart
    await tg.tgGetUpdates(-1);
    console.log("[TELEGRAM] Polling dimulai...");

    while (true) {
        const data = await tg.tgGetUpdates(offset);
        if (data && data.result) {
            for (const upd of data.result) {
                offset = upd.update_id + 1;
                
                // Handle Pesan Masuk
                if (upd.message) {
                    await commands.processCommand(upd.message);
                }

                // Handle Callback Query (Tombol)
                if (upd.callback_query) {
                    await callbacks.processCallback(upd.callback_query);
                }
            }
        }
        await new Promise(r => setTimeout(r, 50));
    }
}

// --- FUNGSI UTAMA ---
async function main() {
    console.log("[INFO] Menjalankan NodeJS Bot...");
    
    // 1. Inisialisasi File Database (JSON)
    db.initializeFiles();
    
    // 2. Menjalankan Internal Monitors (Shared Memory)
    console.log("[INFO] Mengaktifkan semua sistem monitor...");
    
    // Mencari nomor baru di dashboard
    require('./range.js'); 
    
    // Mengambil pesan masuk dari dashboard ke smc.json
    require('./message.js'); 

    // MENGIRIM OTP DARI smc.json KE USER TELEGRAM (File yang Anda maksud)
    require('./sms.js'); 

    // 3. Cron Job: Refresh Browser (Setiap jam 07:00 WIB)
    cron.schedule('0 7 * * *', async () => {
        console.log("[CRON] Menyegarkan Sesi Browser (07:00 WIB)...");
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

    // 4. Jalankan Browser dan Loop Utama
    try {
        // Inisialisasi browser untuk digunakan range.js dan message.js
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
