const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

// Load Env
dotenv.config();

// ================= Konfigurasi Global =================
const BOT_TOKEN = process.env.BOT_TOKEN || "7562117237:AAFQnb5aCmeSHHi_qAJz3vkoX4HbNGohe38";
const ADMIN_ID = process.env.ADMIN_ID || "7184123643";
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const WAIT_TIMEOUT_SECONDS = parseInt(process.env.WAIT_TIMEOUT_SECONDS || "1800");
const EXTENDED_WAIT_SECONDS = 300;
const OTP_REWARD_PRICE = 0.003500;

const SMC_FILE = "smc.json";
const WAIT_FILE = "helpers/wait.json"; // Disesuaikan dengan struktur folder Anda
const PROFILE_FILE = "profile.json";
const SETTINGS_FILE = "settings.json";
const DONATE_LINK = "https://zurastore.my.id/donate";

// State Global
let globalSettings = { balance_enabled: true };

// ================= Fungsi Utilitas =================

/**
 * Helper: Escape HTML untuk Telegram
 * Menghindari error "Can't parse entities" atau pemblokiran karena karakter < > &
 */
function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
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
        const dir = path.dirname(filename);
        if (!fs.existsSync(dir) && dir !== '.') {
            fs.mkdirSync(dir, { recursive: true });
        }
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
        if (e.response) {
            console.error(`❌ [TG API ERROR] ${method}: ${JSON.stringify(e.response.data)}`);
        }
        return null;
    }
}

// Helper: Update Profile & Saldo
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

// ================= Logika Utama =================

async function adminLoop() {
    let lastUpdateId = 0;
    console.log("[SYSTEM] Admin Command Listener Aktif.");

    while (true) {
        try {
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
                            } else if (text === "/startbalance") {
                                globalSettings.balance_enabled = true;
                                saveJson(SETTINGS_FILE, globalSettings);
                                await tgApi("sendMessage", {
                                    chat_id: userId,
                                    text: "✅ <b>Balance Diaktifkan Kembali.</b>",
                                    parse_mode: "HTML"
                                });
                            }
                        }
                    }
                }
            }
        } catch (e) {}
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function checkAndForward() {
    const waitList = loadJson(WAIT_FILE, []);
    if (waitList.length === 0) return;

    let smsData = loadJson(SMC_FILE, []);
    if (!Array.isArray(smsData)) smsData = [];

    let newWaitList = [];
    const currentTime = Date.now() / 1000;
    let smsChanged = false;
    
    const balanceActive = globalSettings.balance_enabled;

    for (const waitItem of waitList) {
        const waitNum = String(waitItem.number);
        const userId = waitItem.user_id;
        const startTs = waitItem.timestamp || 0;
        const otpRecTime = waitItem.otp_received_time;

        if (otpRecTime) {
            if (currentTime - otpRecTime > EXTENDED_WAIT_SECONDS) continue; 
            newWaitList.push(waitItem);
            continue;
        }

        if (currentTime - startTs > WAIT_TIMEOUT_SECONDS) {
            await tgApi("sendMessage", {
                chat_id: userId,
                text: `⚠️ <b>Waktu Habis</b>\nNomor <code>${waitNum}</code> dihapus.`,
                parse_mode: "HTML"
            });
            continue;
        }

        let targetSmsIndex = -1;
        for (let i = 0; i < smsData.length; i++) {
            const sms = smsData[i];
            const smsNum = String(sms.number || sms.Number || "");
            if (smsNum.includes(waitNum.replace('+', '')) || waitNum.includes(smsNum.replace('+', ''))) {
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
            
            // PENTING: Escape isi pesan agar <#> tidak dianggap tag HTML rusak
            const raw = escapeHtml(sms.full_message || sms.FullMessage || "");

            let balTxt = "";
            if (!balanceActive) {
                balTxt = "<b>Not available</b>";
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
                    { text: ` ${otp}`, copy_text: { text: otp } }, // Tombol Copy Format Baru
                    { text: "💸 Donate", url: DONATE_LINK }
                ]]
            };

            const result = await tgApi("sendMessage", {
                chat_id: userId,
                text: msgBody,
                reply_markup: kb,
                parse_mode: "HTML"
            });

            if (result) {
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

async function main() {
    const savedSettings = loadJson(SETTINGS_FILE, { balance_enabled: true });
    globalSettings = savedSettings;

    if (fs.existsSync(SMC_FILE)) saveJson(SMC_FILE, []);

    console.log("========================================");
    console.log(`[STARTED] Monitor OTP Aktif`);
    console.log("========================================");

    adminLoop();

    while (true) {
        try {
            await checkAndForward();
        } catch (e) {
            console.error(`[LOOP ERROR]`, e);
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
}

main();
