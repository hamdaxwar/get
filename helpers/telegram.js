const axios = require('axios');
const config = require('../config');
const db = require('./database');

/**
 * Helper: Penanganan Rate Limit (429)
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
 * Answer Callback Query (hilangkan loading tombol inline)
 */
async function tgAnswerCallback(callbackQueryId, text = "") {
    try {
        await axios.post(`${config.API_URL}/answerCallbackQuery`, {
            callback_query_id: callbackQueryId,
            text: text,
            show_alert: false
        });
    } catch (e) {
        await handleRateLimit(e);
    }
}

/**
 * Send Message
 */
async function tgSend(chatId, text, replyMarkup = null) {
    const data = { 
        chat_id: chatId, 
        text, 
        parse_mode: "HTML",
        disable_web_page_preview: true 
    };
    if (replyMarkup) data.reply_markup = replyMarkup;

    try {
        const res = await axios.post(`${config.API_URL}/sendMessage`, data);
        if (res.data.ok) return res.data.result.message_id;
    } catch (e) {
        if (await handleRateLimit(e)) return tgSend(chatId, text, replyMarkup);
        console.error("❌ [TG ERROR] SendMessage:", e.message);
        return null;
    }
    return null;
}

/**
 * Edit Message
 */
async function tgEdit(chatId, messageId, text, replyMarkup = null) {
    const data = { 
        chat_id: chatId, 
        message_id: messageId, 
        text, 
        parse_mode: "HTML",
        disable_web_page_preview: true
    };
    if (replyMarkup) data.reply_markup = replyMarkup;

    try {
        await axios.post(`${config.API_URL}/editMessageText`, data);
    } catch (e) {
        if (e.response?.data?.description?.includes("message is not modified")) return;
        if (await handleRateLimit(e)) return tgEdit(chatId, messageId, text, replyMarkup);
    }
}

/**
 * Delete Message
 */
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

/**
 * Send Chat Action (typing, upload_photo, etc)
 */
async function tgSendAction(chatId, action = "typing") {
    try {
        await axios.post(`${config.API_URL}/sendChatAction`, {
            chat_id: chatId,
            action
        });
    } catch (e) {
        await handleRateLimit(e);
    }
}

/**
 * Send Animation (GIF)
 */
async function tgSendAnimation(chatId, gifUrl, caption = "", replyMarkup = null) {
    const data = {
        chat_id: chatId,
        animation: gifUrl,
        caption,
        parse_mode: "HTML"
    };

    if (replyMarkup) data.reply_markup = replyMarkup;

    try {
        const res = await axios.post(`${config.API_URL}/sendAnimation`, data);
        if (res.data.ok) return res.data.result.message_id;
    } catch (e) {
        if (await handleRateLimit(e)) return tgSendAnimation(chatId, gifUrl, caption, replyMarkup);
        return null;
    }
    return null;
}

/**
 * Get Updates (Long Polling)
 */
async function tgGetUpdates(offset) {
    try {
        const res = await axios.get(`${config.API_URL}/getUpdates`, {
            params: { offset, timeout: 20 }
        });
        return res.data;
    } catch (e) {
        if (e.response && e.response.status === 429) {
            const retryAfter = (e.response.data.parameters?.retry_after || 10) * 1000;
            console.log(`[POLLING] Rate limit. Menunggu ${retryAfter / 1000}s...`);
            await new Promise(r => setTimeout(r, retryAfter));
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
        return { ok: false, result: [] };
    }
}

/**
 * Check User in Group
 */
async function isUserInGroup(userId, groupId) {
    try {
        const res = await axios.get(`${config.API_URL}/getChatMember`, {
            params: { chat_id: groupId, user_id: userId }
        });
        if (!res.data.ok) return false;
        const status = res.data.result.status;
        return ["member", "administrator", "creator"].includes(status);
    } catch {
        return false;
    }
}

/**
 * Check User in Both Groups
 */
async function isUserInBothGroups(userId) {
    const [g1, g2] = await Promise.all([
        isUserInGroup(userId, config.GROUP_ID_1),
        isUserInGroup(userId, config.GROUP_ID_2)
    ]);
    return g1 && g2;
}

/**
 * Broadcast Message
 */
async function tgBroadcast(messageText, adminId) {
    const userIds = Array.from(db.loadUsers());
    let success = 0;
    let fail = 0;

    let adminMsgId = await tgSend(
        adminId,
        `🔄 Memulai siaran ke <b>${userIds.length}</b> pengguna.\n⏱ Estimasi waktu: <b>${userIds.length} detik</b>.`
    );

    for (let i = 0; i < userIds.length; i++) {
        const uid = userIds[i];

        if (i % 5 === 0 && adminMsgId) {
            await tgEdit(
                adminId,
                adminMsgId,
                `🔄 Siaran Sedang Berjalan...\n\n📊 Progress: <b>${i}/${userIds.length}</b>\n✅ Sukses: <b>${success}</b>\n❌ Gagal: <b>${fail}</b>`
            );
        }

        const res = await tgSend(uid, messageText);
        if (res) success++; else fail++;
        await new Promise(r => setTimeout(r, 1000));
    }

    const report = `✅ <b>Siaran Selesai!</b>\n\n🟢 Berhasil: <b>${success}</b>\n🔴 Gagal: <b>${fail}</b>`;
    if (adminMsgId) await tgEdit(adminId, adminMsgId, report);
    else await tgSend(adminId, report);
}

module.exports = {
    tgSend,
    tgEdit,
    tgDelete,
    tgSendAction,
    tgSendAnimation,
    tgGetUpdates,
    isUserInGroup,
    isUserInBothGroups,
    tgBroadcast,
    tgAnswerCallback // ✅ penting
};
