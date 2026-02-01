const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

// Load Env
dotenv.config();

// ================= Konfigurasi Global =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const WAIT_TIMEOUT_SECONDS = parseInt(process.env.WAIT_TIMEOUT_SECONDS || "1800");
const EXTENDED_WAIT_SECONDS = 300;
const OTP_REWARD_PRICE = 0.003500;

const SMC_FILE = "smc.json";
const WAIT_FILE = "wait.json";
const PROFILE_FILE = "profile.json";
const SETTINGS_FILE = "settings.json";
const DONATE_LINK = "https://zurastore.my.id/donate";

// ================= Fungsi Utilitas =================

/**
 * Helper: Membersihkan nomor telepon agar hanya tersisa angka
 */
function normalize(phone) {
    if (!phone) return "";
    return String(phone).replace(/[^\d]/g, '');
}

/**
 * Helper: Escape HTML untuk Telegram
 */
function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * Helper: Load JSON
 */
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

/**
 * Helper: Save JSON
 */
function saveJson(filename, data) {
    try {
        fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`[ERROR] Gagal menyimpan ${filename}:`, e.message);
    }
}

/**
 * Helper: API Telegram dengan Error Handling 429
 */
async function tgApi(method, data) {
    try {
        const response = await axios.post(`${API}/${method}`, data, { timeout: 10000 });
        return response.data;
    } catch (e) {
        if (e.response && e.response.status === 429) {
            const retryAfter = (e.response.data.parameters?.retry_after || 5) * 1000;
            console.log(`[SMS-API] Rate limit terdeteksi. Menunggu ${retryAfter/1000}s...`);
            await new Promise(r => setTimeout(r, retryAfter));
            return tgApi(method, data);
        }
        return null;
    }
}

/**
 * Helper: Update Profile & Saldo
 */
function updateProfileOtp(userId) {
    const profiles = loadJson(PROFILE_FILE, {});
    const strId = String(userId);
    const today = new Date().toISOString().split('T')[0];

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

// ================= Logika Utama Monitor =================

async function checkAndForward() {
    // Selalu ambil settings terbaru
    const globalSettings = loadJson(SETTINGS_FILE, { balance_enabled: true });
    
    const waitList = loadJson(WAIT_FILE, []);
    if (waitList.length === 0) return;

    let smsData = loadJson(SMC_FILE, []);
    if (!Array.isArray(smsData)) smsData = [];

    let newWaitList = [];
    const currentTime = Date.now() / 1000;
    let smsChanged = false;

    for (const waitItem of waitList) {
        const waitNumClean = normalize(waitItem.number);
        const userId = waitItem.user_id;
        const startTs = waitItem.timestamp || 0;
        const otpRecTime = waitItem.otp_received_time;

        // 1. Cek Extended Wait (Setelah dapat OTP)
        if (otpRecTime) {
            if (currentTime - otpRecTime > EXTENDED_WAIT_SECONDS) continue;
            newWaitList.push(waitItem);
            continue;
        }

        // 2. Cek Timeout (Sebelum dapat OTP)
        if (currentTime - startTs > WAIT_TIMEOUT_SECONDS) {
            await tgApi("sendMessage", {
                chat_id: userId,
                text: `⚠️ <b>Waktu Habis</b>\nNomor <code>${waitItem.number}</code> dihapus dari antrean.`,
                parse_mode: "HTML"
            });
            continue;
        }

        // 3. Pencocokan Nomor
        let targetSmsIndex = -1;
        for (let i = 0; i < smsData.length; i++) {
            const smsNumClean = normalize(smsData[i].number || smsData[i].Number);
            // Match jika nomor sama persis atau mengandung nomor target
            if (smsNumClean === waitNumClean || smsNumClean.endsWith(waitNumClean) || waitNumClean.endsWith(smsNumClean)) {
                targetSmsIndex = i;
                break;
            }
        }

        if (targetSmsIndex !== -1) {
            const sms = smsData[targetSmsIndex];
            smsData.splice(targetSmsIndex, 1);
            smsChanged = true;

            const otp = sms.otp || sms.OTP || "N/A";
            const svc = sms.service || "Unknown";
            const raw = escapeHtml(sms.full_message || sms.FullMessage || "");

            // Logic Reward Balance
            let balTxt = "";
            if (!globalSettings.balance_enabled) {
                balTxt = "<b>Balance Sedang Nonaktif</b>";
            } else if (svc.toLowerCase().includes("whatsapp")) {
                balTxt = "<i>WhatsApp OTP (No Reward)</i>";
            } else {
                const bal = updateProfileOtp(userId);
                balTxt = `$${bal.old.toFixed(6)} > $${bal.new.toFixed(6)}`;
            }

            const msgBody = `🔔 <b>Pesan OTP Terdeteksi</b>\n\n` +
                            `☎️ <b>Nomor:</b> <code>${waitItem.number}</code>\n` +
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

            const success = await tgApi("sendMessage", {
                chat_id: userId,
                text: msgBody,
                reply_markup: kb,
                parse_mode: "HTML"
            });

            if (success) {
                waitItem.otp_received_time = currentTime;
            }
            newWaitList.push(waitItem);
        } else {
            newWaitList.push(waitItem);
        }
    }

    if (smsChanged) saveJson(SMC_FILE, smsData);
    saveJson(WAIT_FILE, newWaitList);
}

// Loop Pengecekan SMS
async function startMonitor() {
    console.log("========================================");
    console.log(`[STARTED] SMS Forwarder Active Loop`);
    console.log("========================================");
    
    // Bersihkan SMC File saat start jika ada
    if (fs.existsSync(SMC_FILE)) saveJson(SMC_FILE, []);

    while (true) {
        try {
            await checkAndForward();
        } catch (e) {
            console.error(`[SMS LOOP ERROR]`, e.message);
        }
        // Jeda 3 detik agar tidak membebani I/O
        await new Promise(r => setTimeout(r, 3000));
    }
}

// Eksekusi monitor
startMonitor();
