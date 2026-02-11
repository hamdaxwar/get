const config = require('../config');
const db = require('../helpers/database');
const tg = require('../helpers/telegram');
const { state } = require('../helpers/state');
const scraper = require('../helpers/scraper');
const adminHandler = require('./admin');
const fs = require('fs');

// =====================
// AUTO DELETE CHAT
// =====================
async function clearChatBeforeReply(chatId, userId, userMsgId) {
    try {
        // hapus pesan user
        if (userMsgId) {
            await tg.tgDelete(chatId, userMsgId).catch(() => {});
        }

        // hapus pesan bot sebelumnya
        if (state.lastBotMessage[userId]) {
            await tg.tgDelete(chatId, state.lastBotMessage[userId]).catch(() => {});
        }
    } catch (e) {
        console.log("clearChat error:", e.message);
    }
}

// kirim pesan + simpan message_id bot
async function sendAndTrack(chatId, userId, text, kb) {
    const sent = await tg.tgSend(chatId, text, kb);
    // Simpan hanya ID pesan saja (Integer)
    if (sent) {
        state.lastBotMessage[userId] = sent;
    }
    return sent;
}

async function processCommand(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userMsgId = msg.message_id;
    const firstName = msg.from.first_name || "User";
    const usernameTg = msg.from.username;
    const mention = usernameTg ? `@${usernameTg}` : `<a href='tg://user?id=${userId}'>${firstName}</a>`;
    const text = msg.text || "";

    // ✅ AUTO DELETE USER + BOT MESSAGE
    await clearChatBeforeReply(chatId, userId, userMsgId);

    // =====================
    // ADMIN COMMANDS
    // =====================
    if (userId === config.ADMIN_ID) {
        if (text.startsWith("/add")) {
            state.waitingAdminInput.add(userId);
            const prompt = "Silahkan kirim daftar range dalam format:\n\n<code>range > country > service</code>\nAtau default service WA:\n<code>range > country</code>\n\nContoh:\n<code>23273XXX > SIERRA LEONE > WA</code>";
            const mid = await sendAndTrack(userId, userId, prompt);
            if (mid) state.pendingMessage[userId] = mid;
            return;
        } 
        else if (text === "/info") {
            state.waitingBroadcastInput.add(userId);
            const mid = await sendAndTrack(userId, userId, "<b>Pesan Siaran</b>\n\nKirim pesan yang ingin disiarkan. Ketik <code>.batal</code> untuk batal.");
            if (mid) state.broadcastMessage[userId] = mid;
            return;
        } 
        else if (text.startsWith("/get10akses ")) {
            const targetId = text.split(" ")[1];
            db.saveAksesGet10(targetId);
            await sendAndTrack(userId, userId, `✅ User <code>${targetId}</code> berhasil diberi akses /get10.`);
            return;
        } 
        else if (text === "/list") {
            await adminHandler.handleListUsers(userId);
            return;
        }
        else if (text === "/onbalance") {
            const settings = { balance_enabled: true };
            fs.writeFileSync('settings.json', JSON.stringify(settings, null, 2));
            await sendAndTrack(userId, userId, "🟢 <b>Sistem Saldo Diaktifkan.</b>\nReward $0.003500 akan masuk untuk setiap OTP (Kecuali WhatsApp).");
            return;
        }
        else if (text === "/offbalance") {
            const settings = { balance_enabled: false };
            fs.writeFileSync('settings.json', JSON.stringify(settings, null, 2));
            await sendAndTrack(userId, userId, "🔴 <b>Sistem Saldo Dinonaktifkan.</b>\nUser tidak akan mendapatkan reward saldo tambahan sementara waktu.");
            return;
        }
    }

    // =====================
    // GET10
    // =====================
    if (text === "/get10") {
        if (db.hasGet10Access(userId)) {
            state.get10RangeInput.add(userId);
            const mid = await sendAndTrack(userId, userId, "kirim range contoh 225071606XXX");
            if (mid) state.pendingMessage[userId] = mid;
        } else {
            await sendAndTrack(userId, userId, "❌ Anda tidak memiliki akses untuk perintah ini.");
        }
        return;
    }

    // =====================
    // STATE HANDLERS
    // =====================
    if (state.waitingAdminInput.has(userId)) {
        state.waitingAdminInput.delete(userId);
        const pMsgId = state.pendingMessage[userId];
        delete state.pendingMessage[userId];
        await adminHandler.handleAddRange(userId, text, pMsgId);
        return;
    }

    if (state.waitingBroadcastInput.has(userId)) {
        state.waitingBroadcastInput.delete(userId);
        const pMsgId = state.broadcastMessage[userId];
        delete state.broadcastMessage[userId];
        await adminHandler.handleBroadcast(userId, chatId, text, pMsgId);
        return;
    }

    if (state.waitingDanaInput.has(userId)) {
        const lines = text.trim().split('\n');
        if (lines.length >= 2) {
            const dNum = lines[0].trim();
            const dName = lines.slice(1).join(' ').trim();
            if (/^[\d+]+$/.test(dNum)) {
                state.waitingDanaInput.delete(userId);
                db.updateUserDana(userId, dNum, dName);
                await sendAndTrack(userId, userId, `✅ <b>Dana Berhasil Disimpan!</b>\n\nNo: ${dNum}\nA/N: ${dName}`);
            } else {
                await sendAndTrack(userId, userId, "❌ Format salah. Pastikan baris pertama adalah NOMOR DANA.");
            }
        } else {
            await sendAndTrack(userId, userId, "❌ Format salah. Mohon kirim:\n\n<code>08123456789\nNama Pemilik</code>");
        }
        return;
    }

    // =====================
    // GET10 RANGE INPUT
    // =====================
    if (state.get10RangeInput.has(userId)) {
        state.get10RangeInput.delete(userId);
        const prefix = text.trim();
        let menuMsgId = state.pendingMessage[userId];
        delete state.pendingMessage[userId];

        if (/^\+?\d{3,15}[Xx*#]+$/.test(prefix)) {
            if (!menuMsgId) {
                // PARAMETER: getProgressMessage(step, total, prefix, count)
                const sent = await sendAndTrack(chatId, userId, scraper.getProgressMessage(0, 5, prefix, 10));
                menuMsgId = sent;
            } else {
                await tg.tgEdit(chatId, menuMsgId, scraper.getProgressMessage(0, 5, prefix, 10));
            }
            scraper.processUserInput(userId, prefix, 10, usernameTg, firstName, menuMsgId);
        } else {
            await sendAndTrack(chatId, userId, "❌ Format Range tidak valid.");
        }
        return;
    }

    // =====================
    // MANUAL RANGE INPUT
    // =====================
    const isManualFormat = /^\+?\d{3,15}[Xx*#]+$/.test(text.trim());
    if (state.manualRangeInput.has(userId) || (state.verifiedUsers.has(userId) && isManualFormat)) {
        state.manualRangeInput.delete(userId);
        const prefix = text.trim();
        let menuMsgId = state.pendingMessage[userId];
        delete state.pendingMessage[userId];

        if (isManualFormat) {
            if (!menuMsgId) {
                // PARAMETER: getProgressMessage(step, total, prefix, count)
                const sent = await sendAndTrack(chatId, userId, scraper.getProgressMessage(0, 5, prefix, 1));
                menuMsgId = sent;
            } else {
                await tg.tgEdit(chatId, menuMsgId, scraper.getProgressMessage(0, 5, prefix, 1));
            }
            scraper.processUserInput(userId, prefix, 1, usernameTg, firstName, menuMsgId);
        } else {
            await sendAndTrack(chatId, userId, "❌ Format Range tidak valid.");
        }
        return;
    }

    // =====================
    // SET DANA
    // =====================
    if (text.startsWith("/setdana")) {
        state.waitingDanaInput.add(userId);
        await sendAndTrack(userId, userId, "Silahkan kirim dana dalam format:\n\n<code>08123456789\nNama Pemilik</code>");
        return;
    }

    // =====================
    // START COMMAND
    // =====================
    if (text === "/start") {
        if (await tg.isUserInBothGroups(userId)) {
            state.verifiedUsers.add(userId);
            db.saveUsers(userId);
            const prof = db.getUserProfile(userId, firstName);
            const fullName = usernameTg ? `${firstName} (@${usernameTg})` : firstName;

            const msgProfile =
                `<blockquote>✅ <b>Verifikasi Berhasil, ${mention}</b>\n\n` +
                `👤 <b>Profil Anda :</b>\n` +
                `🔖 <b>Nama</b> : ${fullName}\n` +
                `🧾 <b>Dana</b> : ${prof.dana}\n` +
                `👤 <b>A/N</b> : ${prof.dana_an}\n` +
                `📊 <b>Total of all OTPs</b> : ${prof.otp_semua}\n` +
                `📊 <b>daily OTP count</b> : ${prof.otp_hari_ini}\n` +
                `💰 <b>Balance</b> : $${prof.balance.toFixed(6)}\n</blockquote>`;

            const kb = {
                inline_keyboard: [
                    [{ text: "📲 Get Number", callback_data: "getnum" }, { text: "👨‍💼 Admin", url: "https://t.me/Imr1d" }],
                    [{ text: "💸 Withdraw Money", callback_data: "withdraw_menu" }]
                ]
            };

            await sendAndTrack(userId, userId, msgProfile, kb);
        } else {
            const kb = {
                inline_keyboard: [
                    [{ text: "📌 Gabung Grup 1", url: config.GROUP_LINK_1 }],
                    [{ text: "📌 Gabung Grup 2", url: config.GROUP_LINK_2 }],
                    [{ text: "✅ Verifikasi Ulang", callback_data: "verify" }]
                ]
            };
            await sendAndTrack(userId, userId, `Halo ${mention} 👋\nHarap gabung kedua grup di bawah untuk verifikasi:`, kb);
        }
    }
}

module.exports = { processCommand };
