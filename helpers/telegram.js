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

async function tgSend(chatId, text, replyMarkup = null) {
    const data = { chat_id: chatId, text: text, parse_mode: "HTML" };
    if (replyMarkup) data.reply_markup = replyMarkup;
    try {
        const res = await axios.post(`${config.API_URL}/sendMessage`, data);
        if (res.data.ok) return res.data.result.message_id;
    } catch (e) {
        if (await handleRateLimit(e)) return tgSend(chatId, text, replyMarkup);
        return null;
    }
    return null;
}

async function tgEdit(chatId, messageId, text, replyMarkup = null) {
    const data = { chat_id: chatId, message_id: messageId, text: text, parse_mode: "HTML" };
    if (replyMarkup) data.reply_markup = replyMarkup;
    try {
        await axios.post(`${config.API_URL}/editMessageText`, data);
    } catch (e) {
        await handleRateLimit(e);
    }
}

async function tgDelete(chatId, messageId) {
    try {
        await axios.post(`${config.API_URL}/deleteMessage`, { chat_id: chatId, message_id: messageId });
    } catch (e) {
        await handleRateLimit(e);
    }
}

async function tgSendAction(chatId, action = "typing") {
    try {
        await axios.post(`${config.API_URL}/sendChatAction`, { chat_id: chatId, action: action });
    } catch (e) {
        await handleRateLimit(e);
    }
}

async function tgGetUpdates(offset) {
    try {
        const res = await axios.get(`${config.API_URL}/getUpdates`, { 
            params: { offset: offset, timeout: 20 } 
        });
        return res.data;
    } catch (e) {
        if (e.response && e.response.status === 429) {
            const retryAfter = (e.response.data.parameters?.retry_after || 10) * 1000;
            console.log(`[POLLING] Rate limit. Menunggu ${retryAfter/1000}s...`);
            await new Promise(r => setTimeout(r, retryAfter));
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
        return { ok: false, result: [] };
    }
}

async function isUserInGroup(userId, groupId) {
    try {
        const res = await axios.get(`${config.API_URL}/getChatMember`, { params: { chat_id: groupId, user_id: userId } });
        if (!res.data.ok) return false;
        const status = res.data.result.status;
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

/**
 * Fungsi Broadcast dengan Jeda 1 Detik per User
 */
async function tgBroadcast(messageText, adminId) {
    const userIds = Array.from(db.loadUsers());
    let success = 0;
    let fail = 0;
    
    let adminMsgId = await tgSend(adminId, `🔄 Memulai siaran ke <b>${userIds.length}</b> pengguna.\n⏱ Estimasi waktu: <b>${userIds.length} detik</b>.`);

    for (let i = 0; i < userIds.length; i++) {
        const uid = userIds[i];
        
        // Update status ke admin setiap 5 user agar admin tetap mendapat info progres
        if (i % 5 === 0 && adminMsgId) {
            await tgEdit(adminId, adminMsgId, `🔄 Siaran Sedang Berjalan...\n\n📊 Progress: <b>${i}/${userIds.length}</b>\n✅ Sukses: <b>${success}</b>\n❌ Gagal: <b>${fail}</b>`);
        }

        const res = await tgSend(uid, messageText);
        
        if (res) {
            success++;
        } else {
            fail++;
        }

        // JEDA 1 DETIK (1000ms) per user
        await new Promise(r => setTimeout(r, 1000));
    }
    
    const report = `✅ <b>Siaran Selesai!</b>\n\n👥 Total Pengguna: <b>${userIds.length}</b>\n🟢 Berhasil Terkirim: <b>${success}</b>\n🔴 Gagal Terkirim: <b>${fail}</b>`;
    
    if (adminMsgId) {
        await tgEdit(adminId, adminMsgId, report);
    } else {
        await tgSend(adminId, report);
    }
}

module.exports = {
    tgSend, tgEdit, tgDelete, tgSendAction, tgGetUpdates,
    isUserInGroup, isUserInBothGroups, tgBroadcast
};
