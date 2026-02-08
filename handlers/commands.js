const config = require('../config');
const db = require('../helpers/database');
const tg = require('../helpers/telegram');
const { state } = require('../helpers/state');
const scraper = require('../helpers/scraper');
const adminHandler = require('./admin');

async function processCommand(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || "User";
    const usernameTg = msg.from.username;
    const mention = usernameTg ? `@${usernameTg}` : `<a href='tg://user?id=${userId}'>${firstName}</a>`;
    const text = msg.text || "";

    // --- ADMIN COMMANDS ---
    if (userId === config.ADMIN_ID) {
        if (text.startsWith("/add")) {
            state.waitingAdminInput.add(userId);
            const prompt = "Silahkan kirim daftar range dalam format:\n\n<code>range > country > service</code>\nAtau default service WA:\n<code>range > country</code>\n\nContoh:\n<code>23273XXX > SIERRA LEONE > WA</code>";
            const mid = await tg.tgSend(userId, prompt);
            if (mid) state.pendingMessage[userId] = mid;
            return;
        } 
        else if (text === "/info") {
            state.waitingBroadcastInput.add(userId);
            const mid = await tg.tgSend(userId, "<b>Pesan Siaran</b>\n\nKirim pesan yang ingin disiarkan. Ketik <code>.batal</code> untuk batal.");
            if (mid) state.broadcastMessage[userId] = mid;
            return;
        } 
        else if (text.startsWith("/get10akses ")) {
            const targetId = text.split(" ")[1];
            db.saveAksesGet10(targetId);
            await tg.tgSend(userId, `✅ User <code>${targetId}</code> berhasil diberi akses /get10.`);
            return;
        } 
        else if (text === "/list") {
            await adminHandler.handleListUsers(userId);
            return;
        }
    }

    // --- GET10 ---
    if (text === "/get10") {
        if (db.hasGet10Access(userId)) {
            state.get10RangeInput.add(userId);
            const mid = await tg.tgSend(userId, "kirim range contoh 225071606XXX");
            if (mid) state.pendingMessage[userId] = mid;
        } else {
            await tg.tgSend(userId, "❌ Anda tidak memiliki akses untuk perintah ini.");
        }
        return;
    }

    // --- STATE HANDLERS ---
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
                await tg.tgSend(userId, `✅ <b>Dana Berhasil Disimpan!</b>\n\nNo: ${dNum}\nA/N: ${dName}`);
            } else {
                await tg.tgSend(userId, "❌ Format salah. Pastikan baris pertama adalah NOMOR DANA.");
            }
        } else {
            await tg.tgSend(userId, "❌ Format salah. Mohon kirim:\n\n<code>08123456789\nNama Pemilik</code>");
        }
        return;
    }

    // --- MANUAL & GET10 INPUT PROCESS ---
    if (state.get10RangeInput.has(userId)) {
        state.get10RangeInput.delete(userId);
        const prefix = text.trim();
        let menuMsgId = state.pendingMessage[userId];
        delete state.pendingMessage[userId];
        if (/^\+?\d{3,15}[Xx*#]+$/.test(prefix)) {
            if (!menuMsgId) menuMsgId = await tg.tgSend(chatId, scraper.getProgressMessage(0, 0, prefix, 10));
            else await tg.tgEdit(chatId, menuMsgId, scraper.getProgressMessage(0, 0, prefix, 10));
            scraper.processUserInput(userId, prefix, 10, usernameTg, firstName, menuMsgId);
        } else {
            await tg.tgSend(chatId, "❌ Format Range tidak valid.");
        }
        return;
    }

    const isManualFormat = /^\+?\d{3,15}[Xx*#]+$/.test(text.trim());
    if (state.manualRangeInput.has(userId) || (state.verifiedUsers.has(userId) && isManualFormat)) {
        state.manualRangeInput.delete(userId);
        const prefix = text.trim();
        let menuMsgId = state.pendingMessage[userId];
        delete state.pendingMessage[userId];
        if (isManualFormat) {
            if (!menuMsgId) menuMsgId = await tg.tgSend(chatId, scraper.getProgressMessage(0, 0, prefix, 1));
            else await tg.tgEdit(chatId, menuMsgId, scraper.getProgressMessage(0, 0, prefix, 1));
            scraper.processUserInput(userId, prefix, 1, usernameTg, firstName, menuMsgId);
        } else {
            await tg.tgSend(chatId, "❌ Format Range tidak valid.");
        }
        return;
    }

    if (text.startsWith("/setdana")) {
        state.waitingDanaInput.add(userId);
        await tg.tgSend(userId, "Silahkan kirim dana dalam format:\n\n<code>08123456789\nNama Pemilik</code>");
        return;
    }

    // --- START ---
    if (text === "/start") {
        if (await tg.isUserInBothGroups(userId)) {
            state.verifiedUsers.add(userId);
            db.saveUsers(userId);
            const prof = db.getUserProfile(userId, firstName);
            const fullName = usernameTg ? `${firstName} (@${usernameTg})` : firstName;
            
            const msgProfile = `✅ <b>Verifikasi Berhasil, ${mention}</b>\n\n` +
                `👤 <b>Profil Anda :</b>\n` +
                `🔖 <b>Nama</b> : ${fullName}\n` +
                `🧾 <b>Dana</b> : ${prof.dana}\n` +
                `👤 <b>A/N</b> : ${prof.dana_an}\n` +
                `📊 <b>Total of all OTPs</b> : ${prof.otp_semua}\n` +
                `📊 <b>daily OTP count</b> : ${prof.otp_hari_ini}\n` +
                `💰 <b>Balance</b> : $${prof.balance.toFixed(6)}\n`;

            const kb = {
                inline_keyboard: [
                    [{ text: "📲 Get Number", callback_data: "getnum" }, { text: "👨‍💼 Admin", url: "https://t.me/" }],
                    [{ text: "💸 Withdraw Money", callback_data: "withdraw_menu" }]
                ]
            };
            await tg.tgSend(userId, msgProfile, kb);
        } else {
            const kb = {
                inline_keyboard: [
                    [{ text: "📌 Gabung Grup 1", url: config.GROUP_LINK_1 }],
                    [{ text: "📌 Gabung Grup 2", url: config.GROUP_LINK_2 }],
                    [{ text: "✅ Verifikasi Ulang", callback_data: "verify" }]
                ]
            };
            await tg.tgSend(userId, `Halo ${mention} 👋\nHarap gabung kedua grup di bawah untuk verifikasi:`, kb);
        }
    }
}

module.exports = { processCommand };
