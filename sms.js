const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

// Load Env
dotenv.config();

// ================= Konfigurasi Global =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Timeout & Harga
const WAIT_TIMEOUT_SECONDS = parseInt(process.env.WAIT_TIMEOUT_SECONDS || "1800");
const EXTENDED_WAIT_SECONDS = 300;
const OTP_REWARD_PRICE = 0.003500;

// File Paths
const SMC_FILE = "smc.json";
const WAIT_FILE = "wait.json";
const PROFILE_FILE = "profile.json";
const SETTINGS_FILE = "settings.json";
const DONATE_LINK = "https://zurastore.my.id/donate";

// ================= Fungsi Utilitas =================

/**
 * Membersihkan nomor telepon agar hanya tersisa angka
 */
function normalize(phone) {
    if (!phone) return "";
    return String(phone).replace(/[^\d]/g, '');
}

/**
 * Escape HTML untuk Telegram agar tidak error saat parsing
 */
function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * Load JSON dengan aman
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
 * Save JSON dengan aman
 */
function saveJson(filename, data) {
    try {
        fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`[ERROR] Gagal menyimpan ${filename}:`, e.message);
    }
}

/**
 * Load Settings Global
 */
function loadSettings() {
    return loadJson(SETTINGS_FILE, { balance_enabled: true });
}

/**
 * API Telegram Wrapper
 */
async function tgApi(method, data) {
    try {
        const response = await axios.post(`${API}/${method}`, data, { timeout: 20000 });
        return response.data;
    } catch (e) {
        if (e.response && e.response.status === 429) {
            const retryAfter = (e.response.data.parameters?.retry_after || 5) * 1000;
            console.log(`[API] Rate limit. Menunggu ${retryAfter / 1000}s...`);
            await new Promise(r => setTimeout(r, retryAfter));
            return tgApi(method, data);
        }
        console.error(`[API ERROR] ${method}:`, e.message);
        return null;
    }
}

/**
 * Update Profile & Saldo User
 * Logic: Jika Global Off atau Service WhatsApp -> Saldo tidak nambah
 */
function processUserBalance(userId, serviceName) {
    const settings = loadSettings();
    const profiles = loadJson(PROFILE_FILE, {});
    const strId = String(userId);
    const today = new Date().toISOString().split('T')[0];

    // Inisialisasi User jika baru
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

    const oldBalance = parseFloat(p.balance || 0);
    let newBalance = oldBalance;
    let isRewardGiven = false;

    // Cek Kondisi Reward
    const isWhatsApp = serviceName.toLowerCase().includes("whatsapp");
    const isBalanceOn = settings.balance_enabled;

    if (isBalanceOn && !isWhatsApp) {
        newBalance = oldBalance + OTP_REWARD_PRICE;
        isRewardGiven = true;
    }

    // Update Stats
    p.otp_semua = (p.otp_semua || 0) + 1;
    p.otp_hari_ini = (p.otp_hari_ini || 0) + 1;
    p.balance = newBalance;

    saveJson(PROFILE_FILE, profiles);

    return {
        old: oldBalance.toFixed(6),
        new: newBalance.toFixed(6),
        given: isRewardGiven
    };
}

// ================= BAGIAN 1: Command Handler (/onbalance, /offbalance) =================

let lastUpdateId = 0;

async function handleCommands() {
    try {
        // Long polling sederhana untuk menangkap command
        const updates = await tgApi('getUpdates', {
            offset: lastUpdateId + 1,
            timeout: 10, // Long polling 10 detik
            allowed_updates: ["message"]
        });

        if (updates && updates.result && updates.result.length > 0) {
            for (const update of updates.result) {
                lastUpdateId = update.update_id;
                
                if (update.message && update.message.text) {
                    const chatId = update.message.chat.id;
                    const text = update.message.text.trim();
                    const settings = loadSettings();

                    if (text === '/offbalance') {
                        settings.balance_enabled = false;
                        saveJson(SETTINGS_FILE, settings);
                        await tgApi('sendMessage', {
                            chat_id: chatId,
                            text: "🔴 <b>Sistem Saldo Dinonaktifkan.</b>\nUser tidak akan mendapat reward saldo.",
                            parse_mode: "HTML"
                        });
                        console.log(`[CMD] Balance OFF by ${chatId}`);
                    } 
                    else if (text === '/onbalance') {
                        settings.balance_enabled = true;
                        saveJson(SETTINGS_FILE, settings);
                        await tgApi('sendMessage', {
                            chat_id: chatId,
                            text: "🟢 <b>Sistem Saldo Diaktifkan.</b>\nReward saldo berjalan normal (kecuali WhatsApp).",
                            parse_mode: "HTML"
                        });
                        console.log(`[CMD] Balance ON by ${chatId}`);
                    }
                }
            }
        }
    } catch (e) {
        // Abaikan error timeout/network agar loop tidak mati
    }
    
    // Panggil diri sendiri lagi (Infinite Loop untuk listener)
    setTimeout(handleCommands, 1000);
}

// ================= BAGIAN 2: Monitor SMS & Forwarding =================

async function checkAndForward() {
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

        // --- Logika Waktu ---
        
        // 1. Jika sudah dapat OTP, tunggu sebentar (Extended Wait) lalu hapus
        if (otpRecTime) {
            if (currentTime - otpRecTime > EXTENDED_WAIT_SECONDS) {
                // Hapus dari antrean setelah extended wait selesai
                continue; 
            }
            newWaitList.push(waitItem);
            continue;
        }

        // 2. Jika belum dapat OTP dan timeout habis
        if (currentTime - startTs > WAIT_TIMEOUT_SECONDS) {
            await tgApi("sendMessage", {
                chat_id: userId,
                text: `⚠️ <b>Waktu Habis</b>\nNomor <code>${waitItem.number}</code> dihapus dari antrean.`,
                parse_mode: "HTML"
            });
            continue; // Hapus
        }

        // --- Logika Pencocokan SMS ---
        let targetSmsIndex = -1;
        for (let i = 0; i < smsData.length; i++) {
            const smsNumClean = normalize(smsData[i].number || smsData[i].Number);
            // Match substring (belakang/depan) atau exact
            if (smsNumClean === waitNumClean || 
                (smsNumClean.length > 6 && waitNumClean.endsWith(smsNumClean)) || 
                (waitNumClean.length > 6 && smsNumClean.endsWith(waitNumClean))) {
                targetSmsIndex = i;
                break;
            }
        }

        if (targetSmsIndex !== -1) {
            // SMS Ditemukan!
            const sms = smsData[targetSmsIndex];
            smsData.splice(targetSmsIndex, 1); // Hapus SMS dari smc.json
            smsChanged = true;

            const otp = sms.otp || sms.OTP || "Code";
            const svc = sms.service || "Unknown";
            const rawMsg = escapeHtml(sms.full_message || sms.FullMessage || sms.text || "");
            
            // Proses Saldo
            const balInfo = processUserBalance(userId, svc);

            // Format Pesan Sesuai Permintaan
            const msgBody = `<blockquote>🔔 New message  |  ${rawMsg}</blockquote>\n\n` +
                            `☎️ Nomor: ${waitItem.number}\n` +
                            `⚙️ Service: ${svc}\n\n` +
                            `💰 Added: $${balInfo.old} > $${balInfo.new}\n\n` +
                            `⚡ Tap the Button To Copy OTP ⚡`;

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
                waitItem.otp_received_time = currentTime; // Tandai sudah terima
            }
            newWaitList.push(waitItem);
        } else {
            // Belum ada SMS, simpan kembali ke antrean
            newWaitList.push(waitItem);
        }
    }

    if (smsChanged) saveJson(SMC_FILE, smsData);
    saveJson(WAIT_FILE, newWaitList);
}

// ================= Main Loop =================

async function startSystem() {
    console.log("========================================");
    console.log(`[STARTED] Gemini OTP Bot System`);
    console.log(`[INFO] Monitor Loop & Command Listener Active`);
    console.log("========================================");

    // Bersihkan SMC saat start (opsional, agar tidak memproses SMS basi)
    if (fs.existsSync(SMC_FILE)) saveJson(SMC_FILE, []);

    // Jalankan Command Listener (Background)
    handleCommands();

    // Jalankan Monitor Loop (Blocking / Interval)
    while (true) {
        try {
            await checkAndForward();
        } catch (e) {
            console.error(`[MONITOR ERROR]`, e.message);
        }
        // Delay 2 detik antar pengecekan file
        await new Promise(r => setTimeout(r, 2000));
    }
}

// Jalankan sistem
startSystem();
