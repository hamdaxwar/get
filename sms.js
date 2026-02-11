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

function normalize(phone) {
    if (!phone) return "";
    return String(phone).replace(/[^\d]/g, '');
}

function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

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

function saveJson(filename, data) {
    try {
        fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`[ERROR] Gagal menyimpan ${filename}:`, e.message);
    }
}

async function tgApi(method, data) {
    try {
        const response = await axios.post(`${API}/${method}`, data, { timeout: 15000 });
        return response.data;
    } catch (e) {
        if (e.response && e.response.status === 429) {
            const retryAfter = (e.response.data.parameters?.retry_after || 5) * 1000;
            await new Promise(r => setTimeout(r, retryAfter));
            return tgApi(method, data);
        }
        return null;
    }
}

/**
 * Logika Reward Saldo
 */
function processReward(userId, serviceName) {
    // Ambil setting terbaru tiap kali fungsi dipanggil
    const settings = loadJson(SETTINGS_FILE, { balance_enabled: true });
    const profiles = loadJson(PROFILE_FILE, {});
    const strId = String(userId);
    const today = new Date().toISOString().split('T')[0];

    if (!profiles[strId]) {
        profiles[strId] = { name: "User", balance: 0.0, otp_semua: 0, otp_hari_ini: 0, last_active: today };
    }

    const p = profiles[strId];
    if (p.last_active !== today) {
        p.otp_hari_ini = 0;
        p.last_active = today;
    }

    const oldBal = parseFloat(p.balance || 0);
    let newBal = oldBal;

    // Filter: 1. Balance Global Aktif? 2. Bukan WhatsApp?
    const isWhatsApp = serviceName.toLowerCase().includes("whatsapp");
    const isEnabled = settings.balance_enabled;

    if (isEnabled && !isWhatsApp) {
        newBal = oldBal + OTP_REWARD_PRICE;
    }

    p.otp_semua = (p.otp_semua || 0) + 1;
    p.otp_hari_ini = (p.otp_hari_ini || 0) + 1;
    p.balance = newBal;

    saveJson(PROFILE_FILE, profiles);
    return { old: oldBal.toFixed(6), new: newBal.toFixed(6) };
}

// ================= Logika Monitor =================

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

        if (otpRecTime) {
            if (currentTime - otpRecTime > EXTENDED_WAIT_SECONDS) continue;
            newWaitList.push(waitItem);
            continue;
        }

        if (currentTime - startTs > WAIT_TIMEOUT_SECONDS) {
            await tgApi("sendMessage", {
                chat_id: userId,
                text: `⚠️ <b>Waktu Habis</b>\nNomor <code>${waitItem.number}</code> dihapus.`,
                parse_mode: "HTML"
            });
            continue;
        }

        let targetIdx = -1;
        for (let i = 0; i < smsData.length; i++) {
            const smsNumClean = normalize(smsData[i].number || smsData[i].Number);
            if (smsNumClean === waitNumClean || smsNumClean.endsWith(waitNumClean) || waitNumClean.endsWith(smsNumClean)) {
                targetIdx = i;
                break;
            }
        }

        if (targetIdx !== -1) {
            const sms = smsData[targetIdx];
            smsData.splice(targetIdx, 1);
            smsChanged = true;

            const otp = sms.otp || sms.OTP || "N/A";
            const svc = sms.service || "Unknown";
            const raw = escapeHtml(sms.full_message || sms.FullMessage || "");
            
            // Panggil Logika Reward
            const bal = processReward(userId, svc);

            const msgBody = `<blockquote>New message  |  ${raw}</blockquote>\n\n` +
                            `☎️ Nomor: <code>${waitItem.number}</code>\n` +
                            `⚙️ Service: ${svc}\n\n` +
                            `💰 Added: $${bal.old} > $${bal.new}\n\n` +
                            `⚡ <i>Tap the Button To Copy OTP</i> ⚡`;

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

            if (success) waitItem.otp_received_time = currentTime;
            newWaitList.push(waitItem);
        } else {
            newWaitList.push(waitItem);
        }
    }

    if (smsChanged) saveJson(SMC_FILE, smsData);
    saveJson(WAIT_FILE, newWaitList);
}

async function startMonitor() {
    console.log(`[STARTED] SMS Monitor Active`);
    if (fs.existsSync(SMC_FILE)) saveJson(SMC_FILE, []);

    while (true) {
        try {
            await checkAndForward();
        } catch (e) {
            console.error(`[ERROR]`, e.message);
        }
        await new Promise(r => setTimeout(r, 3000));
    }
}

startMonitor();