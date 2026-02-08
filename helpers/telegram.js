const axios = require('axios');
const config = require('../config');
const db = require('./database');

// Fungsi pembantu untuk urusan Rate Limit Telegram
async function handleRateLimit(e) {
    if (e.response && e.response.status === 429) {
        const retryAfter = (e.response.data.parameters?.retry_after || 10) * 1000;
        console.log(`[!] Rate Limit: Menunggu ${retryAfter / 1000}s`);
        await new Promise(r => setTimeout(r, retryAfter));
        return true;
    }
    return false;
}

// 1. FUNGSI JAWAB CALLBACK (Ini yang bikin tombol gak macet)
async function tgAnswerCallback(callbackQueryId, text = "") {
    if (!callbackQueryId) return;
    try {
        await axios.post(`${config.API_URL}/answerCallbackQuery`, {
            callback_query_id: callbackQueryId,
            text: text
        });
    } catch (e) {
        await handleRateLimit(e);
    }
}

// 2. FUNGSI KIRIM PESAN
async function tgSend(chatId, text, replyMarkup = null) {
    try {
        const data = { 
            chat_id: chatId, 
            text: text, 
            parse_mode: "HTML",
            disable_web_page_preview: true 
        };
        if (replyMarkup) data.reply_markup = replyMarkup;
        
        const res = await axios.post(`${config.API_URL}/sendMessage`, data);
        return res.data?.ok ? res.data.result.message_id : null;
    } catch (e) {
        if (await handleRateLimit(e)) return tgSend(chatId, text, replyMarkup);
        console.error("Error tgSend:", e.message);
        return null;
    }
}

// 3. FUNGSI EDIT PESAN
async function tgEdit(chatId, messageId, text, replyMarkup = null) {
    try {
        const data = { 
            chat_id: chatId, 
            message_id: messageId, 
            text: text, 
            parse_mode: "HTML",
            disable_web_page_preview: true
        };
        if (replyMarkup) data.reply_markup = replyMarkup;
        
        await axios.post(`${config.API_URL}/editMessageText`, data);
    } catch (e) {
        if (await handleRateLimit(e)) return tgEdit(chatId, messageId, text, replyMarkup);
        console.error("Error tgEdit:", e.message);
    }
}

// 4. FUNGSI HAPUS PESAN
async function tgDelete(chatId, messageId) {
    try {
        await axios.post(`${config.API_URL}/deleteMessage`, { 
            chat_id: chatId, 
            message_id: messageId 
        });
    } catch (e) {
        await handleRateLimit(e);
    }
}

// 5. FUNGSI POLLING (Sangat krusial buat main.js)
async function tgGetUpdates(offset) {
    try {
        const res = await axios.get(`${config.API_URL}/getUpdates`, { 
            params: { offset, timeout: 20 } 
        });
        return res.data;
    } catch (e) {
        await new Promise(r => setTimeout(r, 5000));
        return { ok: false, result: [] };
    }
}

// 6. CEK GRUP
async function isUserInGroup(userId, groupId) {
    try {
        const res = await axios.get(`${config.API_URL}/getChatMember`, { 
            params: { chat_id: groupId, user_id: userId } 
        });
        const status = res.data?.result?.status;
        return ["member", "administrator", "creator"].includes(status);
    } catch (e) {
        return false;
    }
}

async function isUserInBothGroups(userId) {
    const [g1, g2] = await Promise.all([
        isUserInGroup(userId, config.GROUP_ID_1),
        isUserInGroup(userId, config.GROUP_ID_2)
    ]);
    return g1 && g2;
}

// EXPORT SEMUA FUNGSI
module.exports = {
    tgSend,
    tgEdit,
    tgDelete,
    tgGetUpdates,
    tgAnswerCallback,
    isUserInGroup,
    isUserInBothGroups
};
