const axios = require('axios');
const config = require('../config');
const db = require('./database');

async function tgSend(chatId, text, replyMarkup = null) {
    const data = { chat_id: chatId, text: text, parse_mode: "HTML" };
    if (replyMarkup) data.reply_markup = replyMarkup;
    try {
        const res = await axios.post(`${config.API_URL}/sendMessage`, data);
        if (res.data.ok) return res.data.result.message_id;
    } catch (e) {
        // console.error("tgSend error:", e.message);
        return null;
    }
    return null;
}

async function tgEdit(chatId, messageId, text, replyMarkup = null) {
    const data = { chat_id: chatId, message_id: messageId, text: text, parse_mode: "HTML" };
    if (replyMarkup) data.reply_markup = replyMarkup;
    try {
        await axios.post(`${config.API_URL}/editMessageText`, data);
    } catch (e) { /* ignore */ }
}

async function tgDelete(chatId, messageId) {
    try {
        await axios.post(`${config.API_URL}/deleteMessage`, { chat_id: chatId, message_id: messageId });
    } catch (e) { /* ignore */ }
}

async function tgSendAction(chatId, action = "typing") {
    try {
        await axios.post(`${config.API_URL}/sendChatAction`, { chat_id: chatId, action: action });
    } catch (e) { /* ignore */ }
}

async function tgGetUpdates(offset) {
    try {
        const res = await axios.get(`${config.API_URL}/getUpdates`, { params: { offset: offset, timeout: 5 } });
        return res.data;
    } catch (e) {
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

async function tgBroadcast(messageText, adminId) {
    const userIds = Array.from(db.loadUsers());
    let success = 0;
    let fail = 0;
    
    let adminMsgId = await tgSend(adminId, `🔄 Memulai siaran ke **${userIds.length}** pengguna. Harap tunggu...`);

    for (let i = 0; i < userIds.length; i++) {
        const uid = userIds[i];
        if (i % 10 === 0 && adminMsgId) {
            await tgEdit(adminId, adminMsgId, `🔄 Siaran: **${i}/${userIds.length}** (Sukses: ${success}, Gagal: ${fail})`);
        }
        const res = await tgSend(uid, messageText);
        if (res) success++; else fail++;
        await new Promise(r => setTimeout(r, 50));
    }
    
    const report = `✅ Siaran Selesai!\n\n👥 Total Pengguna: <b>${userIds.length}</b>\n🟢 Berhasil Terkirim: <b>${success}</b>\n🔴 Gagal Terkirim: <b>${fail}</b>`;
    if (adminMsgId) await tgEdit(adminId, adminMsgId, report);
    else await tgSend(adminId, report);
}

module.exports = {
    tgSend, tgEdit, tgDelete, tgSendAction, tgGetUpdates,
    isUserInGroup, isUserInBothGroups, tgBroadcast
};
