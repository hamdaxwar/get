const axios = require('axios');
const config = require('../config');
const db = require('./database');
const tg = require('./telegram');
const { state } = require('./state');

// --- Helper Functions ---
function getProgressMessage(currentStep, totalSteps, prefixRange, numCount) {
    const progressRatio = Math.min(currentStep / 5, 1.0); 
    const filledCount = Math.ceil(progressRatio * config.BAR.MAX_LENGTH);
    const emptyCount = config.BAR.MAX_LENGTH - filledCount;
    const bar = config.BAR.FILLED.repeat(filledCount) + config.BAR.EMPTY.repeat(emptyCount);
    let status = config.STATUS_MAP[currentStep] || "Memproses...";
    
    return `<code>${status}</code>\n<blockquote>Range: <code>${prefixRange}</code> | Jumlah: <code>${numCount}</code></blockquote>\n<code>Load:</code> [${bar}]`;
}

async function actionTask(userId) {
    return setInterval(() => {
        tg.tgSendAction(userId, "typing");
    }, 4500);
}

// --- MAIN FUNCTION ---
async function processUserInput(userId, prefix, clickCount, usernameTg, firstNameTg, messageIdToEdit = null) {
    let msgId = messageIdToEdit || state.pendingMessage[userId];
    let actionInterval = null;
    const numToFetch = parseInt(clickCount);
    const foundNumbers = [];

    // 1. Validasi Format Range (Tambahkan X otomatis agar API tidak Error)
    const formattedRange = prefix.includes('X') ? prefix : prefix.padEnd(9, 'X');

    if (!msgId) {
        msgId = await tg.tgSend(userId, getProgressMessage(0, 5, formattedRange, numToFetch));
        if (!msgId) return;
    }

    try {
        actionInterval = await actionTask(userId);
        
        for (let i = 0; i < numToFetch; i++) {
            // Update Progress Step 1-3
            const step = Math.min(3, i + 1);
            // Non-blocking update agar UI Telegram responsif
            tg.tgEdit(userId, msgId, getProgressMessage(step, 5, formattedRange, numToFetch)).catch(() => {});

            try {
                const response = await axios.post(config.GET_NUM_URL, {
                    range: formattedRange,
                    is_national: false,
                    remove_plus: false
                }, {
                    headers: {
                        'mapikey': config.MNIT_API_KEY,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                });

                const res = response.data;
                // Sesuai struktur CURL yang kamu berikan
                if (res && res.meta && res.meta.status === "success") {
                    foundNumbers.push({
                        number: res.data.full_number, 
                        country: res.data.country.toUpperCase(),
                        operator: res.data.operator,
                        requestId: res.request_id // Simpan request_id untuk OTP nanti
                    });
                }
            } catch (apiErr) {
                console.error(`[API ERROR] Loop-${i+1}:`, apiErr.response?.data || apiErr.message);
            }
            
            // Delay singkat agar tidak kena rate limit API
            if (numToFetch > 1) await new Promise(r => setTimeout(r, 800));
        }

        if (foundNumbers.length === 0) {
            await tg.tgEdit(userId, msgId, "❌ **NOMOR TIDAK DITEMUKAN**\n\nRange tersebut mungkin kosong atau saldo API habis. Coba range lain.");
            return;
        }

        // Sukses (Step 4)
        await tg.tgEdit(userId, msgId, getProgressMessage(4, 5, formattedRange, numToFetch));

        const mainCountry = foundNumbers[0].country || "ID";
        const emoji = config.COUNTRY_EMOJI[mainCountry] || "🇮🇩";

        // Simpan ke DB & Waitlist
        foundNumbers.forEach(entry => {
            db.saveCache({ 
                number: entry.number, 
                country: entry.country, 
                user_id: userId, 
                time: Date.now() 
            });
            // Pastikan fungsi ini di database.js menerima requestId jika diperlukan
            db.addToWaitList(entry.number, userId, usernameTg, firstNameTg, entry.requestId);
        });

        // Generate Pesan Akhir
        let msg = "💫 <b>New number is ready</b>\n\n";
        foundNumbers.forEach((entry, idx) => {
            msg += `☎️ Number ${idx + 1} : <code>${entry.number}</code>\n`;
        });

        msg += `\n${emoji} COUNTRY : <b>${mainCountry}</b>\n`;
        msg += `🏷️ Range : <code>${formattedRange}</code>\n\n`;
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

        // Hapus pesan loading dan kirim hasil akhir secara simultan (Fast Response)
        await Promise.all([
            tg.tgDelete(userId, msgId).catch(() => {}),
            tg.tgSendAnimation(userId, "https://zura14.web.id/mptourl/botgift_1770672122.gif", msg, inlineKb).then(newId => {
                state.lastBotMessage[userId] = newId;
            })
        ]);

    } catch (e) {
        console.error("[PROCESS ERROR]", e);
        await tg.tgSend(userId, "❌ Terjadi error sistem.");
    } finally {
        if (actionInterval) clearInterval(actionInterval);
    }
}

module.exports = { processUserInput, getProgressMessage };
