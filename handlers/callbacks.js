Const config = require('../config');
const db = require('../helpers/database');
const tg = require('../helpers/telegram');
const { state } = require('../helpers/state');
const scraper = require('../helpers/scraper');

function generateInlineKeyboard(ranges) {
    const keyboard = [];
    ranges.forEach(item => {
        const service = item.service || "WA";
        const text = `${item.emoji} ${item.country} ${service}`;
        const callbackData = `select_range:${item.range}`;
        keyboard.push([{ text: text, callback_data: callbackData }]);
    });
    keyboard.push([{ text: "INPUT MANUAL RANGE..🖊️", callback_data: "manual_range" }]);
    return { inline_keyboard: keyboard };
}

async function processCallback(cq) {
    const userId = cq.from.id;
    const dataCb = cq.data;
    const chatId = cq.message.chat.id;
    const menuMsgId = cq.message.message_id;
    const firstName = cq.from.first_name || "User";
    const usernameTg = cq.from.username;
    const mention = usernameTg ? `@${usernameTg}` : `<a href='tg://user?id=${userId}'>${firstName}</a>`;

    // ==== VERIFY ====
    if (dataCb === "verify") {
        if (!(await tg.isUserInBothGroups(userId))) {
            const kb = {
                inline_keyboard: [
                    [{ text: "📌 Gabung Grup 1", url: config.GROUP_LINK_1 }],
                    [{ text: "📌 Gabung Grup 2", url: config.GROUP_LINK_2 }],
                    [{ text: "✅ Verifikasi Ulang", callback_data: "verify" }]
                ]
            };
            await tg.tgEdit(chatId, menuMsgId, "❌ Belum gabung kedua grup.", kb);
        } else {
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
            await tg.tgEdit(chatId, menuMsgId, msgProfile, kb);
        }
        return;
    }

    // ==== GET NUMBER ====
    if (dataCb === "getnum") {
        if (!state.verifiedUsers.has(userId)) {
            await tg.tgEdit(chatId, menuMsgId, "⚠️ Harap verifikasi dulu.");
            return;
        }
        const ranges = db.loadInlineRanges();
        const kb = ranges.length > 0 ? generateInlineKeyboard(ranges) : { inline_keyboard: [[{ text: "✍️ Input Manual Range", callback_data: "manual_range" }]] };
        await tg.tgEdit(chatId, menuMsgId, "<b>Get Number</b>\n\nSilahkan pilih range atau input manual.", kb);
        return;
    }

    // ==== MANUAL RANGE ====
    if (dataCb === "manual_range") {
        if (!state.verifiedUsers.has(userId)) return;
        state.manualRangeInput.add(userId);
        await tg.tgEdit(chatId, menuMsgId, "<b>Input Manual Range</b>\n\nKirim Range anda, contoh: <code>2327600XXX</code>");
        state.pendingMessage[userId] = menuMsgId;
        return;
    }

    // ==== SELECT RANGE ====
    if (dataCb.startsWith("select_range:")) {
        if (!state.verifiedUsers.has(userId)) return;
        const prefix = dataCb.split(":")[1];
        const msgText = scraper.getProgressMessage(prefix, 1);
        await tg.tgEdit(chatId, menuMsgId, msgText);
        scraper.processUserInput(userId, prefix, 1, usernameTg, firstName, menuMsgId);
        return;
    }

    // ==== CHANGE NUM ====
    if (dataCb.startsWith("change_num:")) {
        if (!state.verifiedUsers.has(userId)) return;
        const parts = dataCb.split(":");
        const numFetch = parseInt(parts[1]);
        const prefix = parts[2];
        await tg.tgDelete(chatId, menuMsgId);
        scraper.processUserInput(userId, prefix, numFetch, usernameTg, firstName);
        return;
    }

    // ==== WITHDRAW ====
    if (dataCb === "withdraw_menu") {
        const prof = db.getUserProfile(userId, firstName);
        const msgWd = `<b>💸 Withdraw Money</b>\n\nSilahkan Pilih Jumlah Withdraw anda\n🧾 Dana: <code>${prof.dana}</code>\n👤 A/N : <code>${prof.dana_an}</code>\n💰 Balance: $${prof.balance.toFixed(6)}\n\n<i>Minimal Withdraw: $${config.MIN_WD_AMOUNT.toFixed(6)}</i>`;
        const kbWd = {
            inline_keyboard: [
                [{ text: "$1.000000", callback_data: "wd_req:1.0" }, { text: "$2.000000", callback_data: "wd_req:2.0" }],
                [{ text: "$3.000000", callback_data: "wd_req:3.0" }, { text: "$5.000000", callback_data: "wd_req:5.0" }],
                [{ text: "⚙️ Setting Dana / Ganti", callback_data: "set_dana_cb" }],
                [{ text: "🔙 Kembali", callback_data: "verify" }]
            ]
        };
        await tg.tgEdit(chatId, menuMsgId, msgWd, kbWd);
        return;
    }

    if (dataCb === "set_dana_cb") {
        state.waitingDanaInput.add(userId);
        await tg.tgEdit(chatId, menuMsgId, "Silahkan kirim dana dalam format:\n\n<code>08123456789\nNama Pemilik</code>");
        return;
    }

    if (dataCb.startsWith("wd_req:")) {
        const amount = parseFloat(dataCb.split(":")[1]);
        const profiles = db.loadProfiles();
        const prof = profiles[String(userId)];

        if (!prof || prof.dana === "Belum Diset") {
            await tg.tgSend(chatId, "❌ Harap Setting Dana terlebih dahulu!");
            return;
        }
        if (prof.balance < amount) {
            await tg.tgSend(chatId, `❌ Saldo tidak cukup! Balance anda: $${prof.balance.toFixed(6)}`);
            return;
        }

        prof.balance -= amount;
        db.saveProfiles(profiles);

        const msgAdmin = `<b>🔔 User meminta Withdraw</b>\n\n👤 User: ${mention}\n🆔 ID: <code>${userId}</code>\n💵 Jumlah: <b>$${amount.toFixed(6)}</b>\n🧾 Dana: <code>${prof.dana}</code>\n👤 A/N: <code>${prof.dana_an}</code>`;
        const kbAdmin = {
            inline_keyboard: [[
                { text: "✅ Approve", callback_data: `wd_act:apr:${userId}:${amount}` },
                { text: "❌ Cancel", callback_data: `wd_act:cncl:${userId}:${amount}` }
            ]]
        };
        await tg.tgSend(config.ADMIN_ID, msgAdmin, kbAdmin);
        await tg.tgEdit(chatId, menuMsgId, "✅ <b>Permintaan Withdraw Terkirim!</b>\nMenunggu persetujuan Admin..");
        return;
    }

    if (dataCb.startsWith("wd_act:")) {
        if (userId !== config.ADMIN_ID) return;
        const parts = dataCb.split(":");
        const action = parts[1];
        const targetId = parseInt(parts[2]);
        const amount = parseFloat(parts[3]);

        if (action === "apr") {
            await tg.tgEdit(chatId, menuMsgId, `✅ Withdraw User ${targetId} sebesar $${amount} DISETUJUI.`);
            const prof = db.getUserProfile(targetId);
            await tg.tgSend(targetId, `<b>✅ Selamat Withdraw Anda Sukses!</b>\n\n💵 Penarikan : $${amount.toFixed(6)}\n💰 Saldo saat ini: $${prof.balance.toFixed(6)}`);
        } else if (action === "cncl") {
            const profiles = db.loadProfiles();
            if (profiles[String(targetId)]) {
                profiles[String(targetId)].balance += amount;
                db.saveProfiles(profiles);
            }
            await tg.tgEdit(chatId, menuMsgId, `❌ Withdraw User ${targetId} sebesar $${amount} DIBATALKAN.`);
            await tg.tgSend(targetId, "❌ Admin membatalkan Withdraw.\nSilahkan chat Admin atau melakukan ulang Withdraw.");
        }
        return;
    }
}

module.exports = { processCallback };
