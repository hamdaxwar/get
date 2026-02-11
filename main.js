const { fork } = require('child_process');
const config = require('./config');
const db = require('./helpers/database');
const tg = require('./helpers/telegram');
const scraper = require('./helpers/scraper');
const { state } = require('./helpers/state');
const commands = require('./handlers/commands');
const callbacks = require('./handlers/callbacks');

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

                if (now - item.timestamp > 1200) {   
                    const msgId = await tg.tgSend(item.user_id, `⚠️ Nomor <code>${item.number}</code> telah kadaluarsa.`);  
                    if (msgId) {  
                        setTimeout(() => tg.tgDelete(item.user_id, msgId).catch(()=>{}), 30000);  
                    }  
                } else {  
                    updatedList.push(item);  
                }  
            }  
            db.saveWaitList(updatedList);  
        } catch (e) { /* silent error */ }
    }, 15000);
}

async function telegramLoop() {
    state.verifiedUsers = db.loadUsers();
    let offset = 0;

    try {
        await tg.tgGetUpdates(-1);
    } catch (e) {}

    console.log("🤖 [TELEGRAM] Polling dimulai (API Mode)...");

    while (true) {
        try {
            const data = await tg.tgGetUpdates(offset);
            if (data && data.result) {
                for (const upd of data.result) {
                    offset = upd.update_id + 1;

                    // Proses Pesan (Command Admin / User)  
                    if (upd.message) {  
                        await commands.processCommand(upd.message).catch(err => console.error("[CMD ERR]", err.message));  
                    }  

                    // Proses Callback (Tombol Inline)  
                    if (upd.callback_query) {  
                        await callbacks.processCallback(upd.callback_query).catch(err => console.error("[CB ERR]", err.message));  
                    }  
                }  
            }  
        } catch (e) {  
            if (e.response && e.response.status === 429) {  
                const retryAfter = (e.response.data.parameters?.retry_after || 10) * 1000;  
                console.log(`⚠️ [WARNING] Telegram Rate Limit. Menunggu ${retryAfter/1000}s...`);  
                await new Promise(r => setTimeout(r, retryAfter));  
            } else {  
                await new Promise(r => setTimeout(r, 5000));  
            }  
        }  
        await new Promise(r => setTimeout(r, 500));
    }
}

async function main() {
    console.log("==========================================");
    console.log("🚀 STARTING ZURA BOT - API VERSION");
    console.log("==========================================");

    // 1. Inisialisasi Database
    console.log("[1/3] Inisialisasi Database...");
    db.initializeFiles();

    // 2. Start Monitors Internally
    console.log("[2/3] Mengaktifkan modul internal...");
    
    // Memuat modul pendukung (Pastikan file ini ada di folder root)
    try {
        require('./range.js');    // Monitoring range
        require('./message.js');  // Logic pesan
        require('./sms.js');      // Monitoring SMS OTP API
        console.log("✅ Semua modul internal aktif.");
    } catch (err) {
        console.error("❌ Gagal memuat modul internal:", err.message);
    }

    console.log("[3/3] Menjalankan Polling & Expiry Task...");
    
    telegramLoop();
    expiryMonitorTask();
}

main().catch(err => console.error("🔥 [CRITICAL]", err.message));
