const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

// Load Env
dotenv.config();

// ================= Konfigurasi Global =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID || "12345678";
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const WAIT_TIMEOUT_SECONDS = parseInt(process.env.WAIT_TIMEOUT_SECONDS || "1800");
const EXTENDED_WAIT_SECONDS = 300;
const OTP_REWARD_PRICE = 0.003500;

const SMC_FILE = "smc.json";
const WAIT_FILE = "wait.json";
const PROFILE_FILE = "profile.json";
const SETTINGS_FILE = "settings.json";
const DONATE_LINK = "https://zurastore.my.id/donate";

// State Global
let globalSettings = { balance_enabled: true };

// ================= Fungsi Utilitas =================

// Helper: Escape HTML untuk Telegram
function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Helper: Load JSON
function loadJson(filename, defaultVal = []) {
    if (fs.existsSync(filename)) {
        try {
            const data = fs.readFileSync(filename, 'utf8');
            return JSON.parse(data);
        } catch (e) {
            return defaultVal;
        }
    }
    return defaultVal;
}

// Helper: Save JSON
function saveJson(filename, data) {
    try {
        fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`[ERROR] Gagal menyimpan ${filename}:`, e.message);
    }
}

// Helper: API Telegram
async function tgApi(method, data) {
    try {
        const response = await axios.post(`${API}/${method}`, data, { timeout: 10000 });
        return response.data;
    } catch (e) {
        // Error handling silent agar tidak spam console
        return null;
    }
}

// Helper: Update Profile & Saldo
function updateProfileOtp(userId) {
    const profiles = loadJson(PROFILE_FILE, {});
    const strId = String(userId);
    const today = new Date().toISOString().split('T')[0]; // Format YYYY-MM-DD

    if (!profiles[strId]) {
        profiles[strId] = {
            name: "User",
            balance: 0.0,
            otp_semua: 0,
            otp_hari_ini: 0,
            last_active: today
        };
    }

    const p = profiles[strId];

    // Reset harian
    if (p.last_active !== today) {
        p.otp_hari_ini = 0;
        p.last_active = today;
    }

    const oldBal = p.balance || 0.0;
    p.otp_semua = (p.otp_semua || 0) + 1;
    p.otp_hari_ini = (p.otp_hari_ini || 0) + 1;
    p.balance = oldBal + OTP_REWARD_PRICE;

    saveJson(PROFILE_FILE, profiles);
    return { old: oldBal, new: p.balance };
}

// ================= Logika Utama =================

// 1. Fungsi Admin Polling (Berjalan di background)
async function adminLoop() {
    let lastUpdateId = 0;
    console.log("[SYSTEM] Admin Command Listener Aktif.");

    while (true) {
        try {
            // Long polling getUpdates
            const res = await axios.get(`${API}/getUpdates`, {
                params: { offset: lastUpdateId + 1, timeout: 20 }
            });

            if (res.data && res.data.ok) {
                for (const up of res.data.result) {
                    lastUpdateId = up.update_id;
                    
                    if (up.message && up.message.text) {
                        const userId = String(up.message.from.id);
                        const text = up.message.text;

                        if (userId === String(ADMIN_ID)) {
                            if (text === "/stopbalance") {
                                globalSettings.balance_enabled = false;
                                saveJson(SETTINGS_FILE, globalSettings);
                                await tgApi("sendMessage", {
                                    chat_id: userId,
                                    text: "🛑 <b>Balance Dinonaktifkan Global.</b>",
                                    parse_mode: "HTML"
                                });
                                console.log("[ADMIN] Balance DISABLED");
                            } else if (text === "/startbalance") {
                                globalSettings.balance_enabled = true;
                                saveJson(SETTINGS_FILE, globalSettings);
                                await tgApi("sendMessage", {
                                    chat_id: userId,
                                    text: "✅ <b>Balance Diaktifkan Kembali.</b>",
                                    parse_mode: "HTML"
                                });
                                console.log("[ADMIN] Balance ENABLED");
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // Ignore timeout errors
        }
        
        // Delay kecil agar tidak membebani CPU jika network error cepat
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// 2. Fungsi Monitor OTP (Core Logic)
async function checkAndForward() {
    const waitList = loadJson(WAIT_FILE, []);
    if (waitList.length === 0) return;

    let smsData = loadJson(SMC_FILE, []);
    // Jika smc.json kosong atau corrupt, jadikan array kosong
    if (!Array.isArray(smsData)) smsData = [];
    if (smsData.length === 0 && waitList.every(w => w.otp_received_time)) {
        // Jika tidak ada SMS baru dan semua waitlist sudah terima OTP (menunggu expiry), skip processing berat
        // Tapi kita harus tetap cek timeout waitlist, jadi lanjut saja
    }

    let newWaitList = [];
    const currentTime = Date.now() / 1000; // Unix timestamp in seconds
    let smsChanged = false;
    
    const balanceActive = globalSettings.balance_enabled;

    for (const waitItem of waitList) {
        const waitNum = String(waitItem.number);
        const userId = waitItem.user_id;
        const startTs = waitItem.timestamp || 0;
        const otpRecTime = waitItem.otp_received_time;

        // 2a. Cek jika OTP sudah diterima sebelumnya (Extended Wait)
        if (otpRecTime) {
            if (currentTime - otpRecTime > EXTENDED_WAIT_SECONDS) {
                // Hapus dari list karena sudah lewat masa extended
                continue; 
            }
            newWaitList.push(waitItem);
            continue;
        }

        // 2b. Cek Timeout Biasa (Belum dapat OTP)
        if (currentTime - startTs > WAIT_TIMEOUT_SECONDS) {
            await tgApi("sendMessage", {
                chat_id: userId,
                text: `⚠️ <b>Waktu Habis</b>\nNomor <code>${waitNum}</code> dihapus.`,
                parse_mode: "HTML"
            });
            continue; // Hapus dari list
        }

        // 2c. Cek Pencocokan dengan SMS Masuk
        let matchFound = false;
        let remainingSms = [];

        // Kita iterasi smsData untuk mencari match
        // Strategi: SMS yang cocok dihapus dari smsData (consumed), sisanya disimpan kembali
        // Tapi karena kita loop waitList, kita harus hati-hati memodifikasi smsData.
        // Pendekatan: Cari match di smsData SAAT INI.
        
        let targetSmsIndex = -1;
        
        for (let i = 0; i < smsData.length; i++) {
            const sms = smsData[i];
            const smsNum = String(sms.number || sms.Number || "");
            
            // Normalisasi sederhana untuk perbandingan (pastikan sama-sama punya + atau tidak)
            // Di bot.js kita pakai normalizeNumber, disini kita asumsi data di JSON sudah bersih/mirip
            // Kita coba match exact string dulu
            if (smsNum === waitNum) {
                targetSmsIndex = i;
                break;
            }
        }

        if (targetSmsIndex !== -1) {
            // MATCH FOUND!
            const sms = smsData[targetSmsIndex];
            // Hapus SMS ini dari array agar tidak diproses user lain (sekali pakai)
            smsData.splice(targetSmsIndex, 1); 
            smsChanged = true;

            const otp = sms.otp || sms.OTP || "N/A";
            const svc = sms.service || "Unknown";
            const raw = escapeHtml(sms.full_message || sms.FullMessage || "");

            // Logic Reward
            let balTxt = "";
            if (!balanceActive) {
                balTxt = "<b>Not available at this time</b>";
            } else if (svc.toLowerCase().includes("whatsapp")) {
                balTxt = "<i>WhatsApp OTP no balance</i>";
            } else {
                const bal = updateProfileOtp(userId);
                balTxt = `$${bal.old.toFixed(6)} > $${bal.new.toFixed(6)}`;
            }

            const msgBody = `🔔 <b>New Message Detected</b>\n\n` +
                            `☎️ <b>Nomor:</b> <code>${waitNum}</code>\n` +
                            `⚙️ <b>Service:</b> <b>${svc}</b>\n\n` +
                            `💰 <b>Added:</b> ${balTxt}\n\n` +
                            `🗯️ <b>Full Message:</b>\n` +
                            `<blockquote>${raw}</blockquote>\n\n` +
                            `⚡ <b>Tap the Button To Copy OTP</b> ⚡`;

            const kb = {
                inline_keyboard: [[
                    { text: ` ${otp}`, copy_text: { text: otp } },
                    { text: "💸 Donate", url: DONATE_LINK }
                ]]
            };

            await tgApi("sendMessage", {
                chat_id: userId,
                text: msgBody,
                reply_markup: kb,
                parse_mode: "HTML"
            });

            // Tandai sudah terima OTP, tapi simpan di waitlist sebentar (extended wait)
            waitItem.otp_received_time = currentTime;
            newWaitList.push(waitItem);

        } else {
            // Tidak ada match, tetap simpan di waitlist
            newWaitList.push(waitItem);
        }
    }

    // Simpan perubahan
    if (smsChanged) {
        saveJson(SMC_FILE, smsData);
    }
    // Selalu simpan waitlist (untuk update timestamp/penghapusan timeout)
    saveJson(WAIT_FILE, newWaitList);
}

// ================= Main Loop =================

async function main() {
    // Load Settings awal
    const savedSettings = loadJson(SETTINGS_FILE, { balance_enabled: true });
    globalSettings = savedSettings;

    // Bersihkan SMC File saat start (Opsional, sesuai python script)
    if (fs.existsSync(SMC_FILE)) {
        saveJson(SMC_FILE, []);
    }

    console.log("========================================");
    console.log(`[STARTED] Monitor OTP & Admin Cmd Aktif`);
    console.log(`[STATUS] Initial Balance: ${globalSettings.balance_enabled}`);
    console.log("========================================");

    // Jalankan Admin Loop (Non-blocking)
    adminLoop();

    // Jalankan Monitor Loop
    while (true) {
        try {
            await checkAndForward();
        } catch (e) {
            console.error(`[LOOP ERROR]`, e);
        }
        // Sleep 2 detik
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

// Jalankan
main();