const axios = require('axios');
const config = require('../config');
const db = require('./database');
const tg = require('./telegram');
const { state } = require('./state');

// ================= KONFIGURASI API (DIAMBIL DARI CONFIG) =================
const API_KEY = config.MNIT_API_KEY; // <-- Diubah
const API_URL = config.GET_NUM_URL; // <-- Diubah

// --- Helper Functions ---

function getProgressMessage(currentStep, totalSteps, prefixRange, numCount) {
    const progressRatio = Math.min(currentStep / 5, 1.0); 
    const filledCount = Math.ceil(progressRatio * config.BAR.MAX_LENGTH);
    const emptyCount = config.BAR.MAX_LENGTH - filledCount;
    const bar = config.BAR.FILLED.repeat(filledCount) + config.BAR.EMPTY.repeat(emptyCount);

    // Mengambil teks status dari STATUS_MAP di config.js
    let status = config.STATUS_MAP[currentStep] || "Memproses...";
    
    return `<code>${status}</code>\n<blockquote>Range: <code>${prefixRange}</code> | Jumlah: <code>${numCount}</code></blockquote>\n<code>Load:</code> [${bar}]`;
}

// --- Typing Action ---
async function actionTask(userId) {
    return setInterval(() => {
        tg.tgSendAction(userId, "typing");
    }, 4500);
}

// --- MAIN FUNCTION (API VERSION) ---

async function processUserInput(userId, prefix, clickCount, usernameTg, firstNameTg, messageIdToEdit = null) {
    let msgId = messageIdToEdit || state.pendingMessage[userId];
    let actionInterval = null;
    const numToFetch = parseInt(clickCount);
    const foundNumbers = [];

    // Kirim progress awal (Step 0)
    if (!msgId) {
        msgId = await tg.tgSend(userId, getProgressMessage(0, 5, prefix, numToFetch));
        if (!msgId) return;
    }

    try {
        actionInterval = await actionTask(userId);
        
        for (let i = 0; i < numToFetch; i++) {
            // Update Progress (Step 1-3)
            const step = Math.min(3, i + 1);
            await tg.tgEdit(userId, msgId, getProgressMessage(step, 5, prefix, numToFetch));

            try {
                const response = await axios.post(API_URL, {
                    range: prefix,
                    is_national: false,
                    remove_plus: false
                }, {
                    headers: {
                        'mapikey': API_KEY,
                        'Content-Type': 'application/json'
                    },
                    timeout: 15000
                });

                if (response.data && response.data.meta.status === "success") {
                    const item = response.data.data;
                    foundNumbers.push({
                        number: item.number, 
                        country: item.country.toUpperCase(),
                        operator: item.operator
                    });
                }
            } catch (apiErr) {
                console.error(`[API ERROR] Gagal ambil nomor ke-${i+1}:`, apiErr.message);
            }
        }

        if (foundNumbers.length === 0) {
            try { await tg.tgDelete(userId, msgId); } catch {}
            const errMsg = await tg.tgSend(userId, "❌ NOMOR TIDAK DITEMUKAN atau API sedang Limit. Coba lagi nanti.");
            state.lastBotMessage[userId] = errMsg;
            return;
        }

        // Sukses (Step 4)
        await tg.tgEdit(userId, msgId, getProgressMessage(4, 5, prefix, numToFetch));

        const mainCountry = foundNumbers[0].country || "UNKNOWN";
        const emoji = config.COUNTRY_EMOJI[mainCountry] || "🏴‍☠️";

        foundNumbers.forEach(entry => {
            db.saveCache({ 
                number: entry.number, 
                country: entry.country, 
                user_id: userId, 
                time: Date.now() 
            });
            db.addToWaitList(entry.number, userId, usernameTg, firstNameTg);
        });

        const gifUrl = "https://zura14.web.id/mptourl/botgift_1770672122.gif";

        let msg = "💫 <b>New number is ready</b>\n\n";
        foundNumbers.forEach((entry, idx) => {
            msg += `☎️ Number ${idx + 1} : <code>${entry.number}</code>\n`;
        });

        msg += `\n${emoji} COUNTRY : <b>${mainCountry}</b>\n`;
        msg += `🏷️ Range : <code>${prefix}</code>\n\n`;
        msg += `<b><i>🤖 Number available please use, Waiting for OTP</i></b>\n`;

        const inlineKb = {
            inline_keyboard: [
                [{ text: "🔄 Change 1 Number", callback_data: `change_num:1:${prefix}` }],
                [{ text: "🔄 Change 3 Number", callback_data: `change_num:3:${prefix}` }],
                [
                    { text: "🔐 OTP Grup", url: config.GROUP_LINK_1 },
                    { text: "🌐 Change Range", callback_data: "getnum" }
                ]
            ]
        };

        try { await tg.tgDelete(userId, msgId); } catch {}
        const sentMsgId = await tg.tgSendAnimation(userId, gifUrl, msg, inlineKb);
        state.lastBotMessage[userId] = sentMsgId;

    } catch (e) {
        console.error("[PROCESS ERROR]", e.message);
        try { await tg.tgDelete(userId, msgId); } catch {}
        await tg.tgSend(userId, "❌ Terjadi error sistem. Mohon hubungi admin.");
    } finally {
        if (actionInterval) clearInterval(actionInterval);
    }
}

module.exports = {
    processUserInput,
    getProgressMessage
};
