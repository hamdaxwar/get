const axios = require('axios');
const config = require('../config');
const db = require('./database');

/**
 * Helper: Penanganan Rate Limit (429) secara Global
 */
async function handleRateLimit(e) {
    if (e.response && e.response.status === 429) {
        const retryAfter = (e.response.data.parameters?.retry_after || 10) * 1000;
        console.log(`[!] Telegram Rate Limit. Menunggu ${retryAfter / 1000} detik...`);
        await new Promise(r => setTimeout(r, retryAfter));
        return true;
    }
    return false;
}

/**
 * Menjawab Callback Query (PENTING untuk Inline Button)
 */
async function tgAnswerCallback(callbackQueryId, text = "", showAlert = false) {
    if (!callbackQueryId) return;
    try {
        await axios.post(`${config.API_URL}/answerCallbackQuery`, {
            callback_query_id: callbackQueryId,
            text: text,
            show_alert: showAlert
        });
    } catch (e) {
        if (await handleRateLimit(e)) return tgAnswerCallback(callbackQueryId, text, showAlert);
    }
}

/**
 * Mengirim Pesan Baru
 */
async function tgSend(chatId, text, replyMarkup = null) {
    const data = { chat_id: chatId, text: text, parse_mode: "HTML" };
    if (replyMarkup) data.reply_markup = replyMarkup;
    try {
        const res = await axios.post(`${config.API_URL}/sendMessage`, data);
        if (res.data && res.data.ok) return res.data.result.message_id;
    } catch (e) {
        if (await handleRateLimit(e)) return tgSend(chatId, text, replyMarkup);
        console.error("[ERROR tgSend]", e.message);
        return null;
    }
    return null;
}

/**
 * Mengedit Pesan yang Sudah Ada
 */
async function tgEdit(chatId, messageId, text, replyMarkup = null) {
    const data = { chat_id: chatId, message_id: messageId, text: text, parse_mode: "HTML" };
    if (replyMarkup) data.reply_markup = replyMarkup;
    try {
        await axios.post(`${config.API_URL}/editMessageText`, data);
    } catch (e) {
        if (await handleRateLimit(e)) return tgEdit(chatId, messageId, text, replyMarkup);
        console.error("[ERROR tgEdit]", e.message);
    }
}

/**
 * Menghapus Pesan
 */
async function tgDelete(chatId, messageId) {
    try {
        await axios.post(`${config.API_URL}/deleteMessage`, { chat_id: chatId, message_id: messageId });
    } catch (e) {
        await handleRateLimit(e);
    }
}

/**
 * Mendapatkan Updates (Polling)
 */
async function tgGetUpdates(offset) {
    try {
        const res = await axios.get(`${config.API_URL}/getUpdates`, { 
            params: { offset: offset, timeout: 20 } 
        });
        return res.data;
    } catch (e) {
        if (e.response && e.response.status === 429) {
            const retryAfter = (e.response.data.parameters?.retry_after || 10) * 1000;
            await new Promise(r => setTimeout(r, retryAfter));
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
        return { ok: false, result: [] };
    }
}

/**
 * Cek apakah user ada di grup
 */
async function isUserInGroup(userId, groupId) {
    try {
        const res = await axios.get(`${config.API_URL}/getChatMember`, { params: { chat_id: groupId, user_id: userId } });
        if (!res.data || !res.data.ok) return false;
        const status = res.data.result.status;
        return ["member", "administrator", "creator"].includes(status);
    } catch (e) {
        return false;
    }
}

async function isUserInBothGroups(userId) {
    try {
        const [g1, g2] = await Promise.all([
            isUserInGroup(userId, config.GROUP_ID_1),
            isUserInGroup(userId, config.GROUP_ID_2)
        ]);
        return g1 && g2;
    } catch (e) {
        return false;
    }
}

/**
 * Pengiriman Siaran (Broadcast)
 */
async function tgBroadcast(messageText, adminId) {
    const userIds = Array.from(db.loadUsers());
    let success = 0;
    let fail = 0;
    
    let adminMsgId = await tgSend(adminId, `🔄 Memulai siaran ke <b>${userIds.length}</b> pengguna.`);

    for (let i = 0; i < userIds.length; i++) {
        const uid = userIds[i];
        const res = await tgSend(uid, messageText);
        if (res) success++; else fail++;
        await new Promise(r => setTimeout(r, 1000));
    }
    
    await tgSend(adminId, `✅ <b>Siaran Selesai!</b>\n\n🟢 Berhasil: ${success}\n🔴 Gagal: ${fail}`);
}

module.exports = {
    tgSend, 
    tgEdit, 
    tgDelete, 
    tgGetUpdates,
    isUserInGroup, 
    isUserInBothGroups, 
    tgBroadcast, 
    tgAnswerCallback
};
