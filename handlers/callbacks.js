const config = require('../config');
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

    // Tutup loading icon di Telegram user
    await tg.tgAnswerCallback(cq.id).catch(() => {});

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
                    [{ text: "📲 Get Number", callback_data: "getnum" }, { text: "👨‍💼 Admin", url: config.ADMIN_TELE_LINK || "https://t.me/" }],
                    [{ text: "💸 Withdraw Money", callback_data: "withdraw_menu" }]
                ]
            };
            await tg.tgEdit(chatId, menuMsgId, msgProfile, kb);
        }
        return;
    }

    // ==== GET NUMBER / CHANGE RANGE ====
    // Ini buat balik ke menu pemilihan range
    if (dataCb === "getnum") {
        if (!state.verifiedUsers.has(userId)) {
            await tg.tgEdit(chatId, menuMsgId, "⚠️ Harap verifikasi dulu.");
            return;
        }

        const ranges = db.loadInlineRanges();
        const kb = ranges.length > 0
            ? generateInlineKeyboard(ranges)
            : { inline_keyboard: [[{ text: "✍️ Input Manual Range", callback_data: "manual_range" }]] };

        // HAPUS PESAN LAMA (Wajib karena pesan nomor biasanya GIF)
        await tg.tgDelete(chatId, menuMsgId).catch(() => {});
        
        // KIRIM PESAN BARU daftar range
        await tg.tgSend(
            chatId,
            '\nPilih range dibawah atau manual range\n<b>👉 <a href="https://t.me/informasiprv">Click Method FB di sini</a></b>\n<blockquote>Range di bawah akan berubah setiap ada yang baru</blockquote>\n',
            kb
        );
        return;
    }

    // ==== MANUAL RANGE INPUT ====
    if (dataCb === "manual_range") {
        if (!state.verifiedUsers.has(userId)) return;
        state.manualRangeInput.add(userId);
        await tg.tgEdit(chatId, menuMsgId, "<blockquote><b>Input Manual Range</b>\n\nKirim Range anda, contoh: <code>2327600XXX</code></blockquote>");
        state.pendingMessage[userId] = menuMsgId;
        return;
    }

    // ==== SELECT RANGE (Klik Range di Menu) ====
    if (dataCb.startsWith("select_range:")) {
        if (!state.verifiedUsers.has(userId)) return;
        const prefix = dataCb.split(":")[1];
        
        const msgLoading = scraper.getProgressMessage(0, 5, prefix, 1);
        await tg.tgEdit(chatId, menuMsgId, msgLoading);
        
        scraper.processUserInput(userId, prefix, 1, usernameTg, firstName, menuMsgId);
        return;
    }

    // ==== CHANGE NUMBER (Request ulang di range yang sama) ====
    if (dataCb.startsWith("change_num:")) {
        if (!state.verifiedUsers.has(userId)) return;
        const parts = dataCb.split(":");
        const numFetch = parseInt(parts[1]);
        const prefix = parts[2];

        // Hapus pesan animasi nomor lama
        await tg.tgDelete(chatId, menuMsgId).catch(() => {});
        
        // Panggil scraper (nanti scraper kirim pesan loading baru)
        scraper.processUserInput(userId, prefix, numFetch, usernameTg, firstName);
        return;
    }

    // ==== WITHDRAW MENU ====
    if (dataCb === "withdraw_menu") {
        const prof = db.getUserProfile(userId, firstName);
        const msgWd = `<b>💸 Withdraw Money</b>\n\n` +
            `Silahkan Pilih Jumlah Withdraw anda\n` +
            `🧾 Dana: <code>${prof.dana}</code>\n` +
            `👤 A/N : <code>${prof.dana_an}</code>\n` +
            `💰 Balance: $${prof.balance.toFixed(6)}\n\n` +
            `<i>Minimal Withdraw: $${config.MIN_WD_AMOUNT.toFixed(6)}</i>`;

        const kbWd = {
            inline_keyboard: [
                [{ text: "$1.0", callback_data: "wd_req:1.0" }, { text: "$2.0", callback_data: "wd_req:2.0" }],
                [{ text: "$3.0", callback_data: "wd_req:3.0" }, { text: "$5.0", callback_data: "wd_req:5.0" }],
                [{ text: "⚙️ Setting Dana", callback_data: "set_dana_cb" }],
                [{ text: "🔙 Kembali", callback_data: "verify" }]
            ]
        };
        await tg.tgEdit(chatId, menuMsgId, msgWd, kbWd);
        return;
    }

    // ==== SET DANA ====
    if (dataCb === "set_dana_cb") {
        state.waitingDanaInput.add(userId);
        await tg.tgEdit(chatId, menuMsgId, "Silahkan kirim dana dalam format:\n\n<code>08123456789\nNama Pemilik</code>");
        return;
    }

    // ==== WD REQUEST & ADMIN ACTION (Tetap Sama) ====
    if (dataCb.startsWith("wd_req:")) {
        // ... kode wd_req lo yang lama ...
        const amount = parseFloat(dataCb.split(":")[1]);
        const profiles = db.loadProfiles();
        const prof = profiles[String(userId)];
        if (!prof || prof.dana === "Belum Diset") {
            await tg.tgSend(chatId, "❌ Harap Setting Dana terlebih dahulu!");
            return;
        }
        if (prof.balance < amount) {
            await tg.tgSend(chatId, `❌ Saldo tidak cukup!`);
            return;
        }
        prof.balance -= amount;
        db.saveProfiles(profiles);
        const msgAdmin = `<b>🔔 User meminta Withdraw</b>\n\n👤 User: ${mention}\n💵 Jumlah: <b>$${amount.toFixed(6)}</b>\n🧾 Dana: <code>${prof.dana}</code>`;
        const kbAdmin = { inline_keyboard: [[{ text: "✅ Approve", callback_data: `wd_act:apr:${userId}:${amount}` }, { text: "❌ Cancel", callback_data: `wd_act:cncl:${userId}:${amount}` }]] };
        await tg.tgSend(config.ADMIN_ID, msgAdmin, kbAdmin);
        await tg.tgEdit(chatId, menuMsgId, "✅ <b>Permintaan Withdraw Terkirim!</b>");
        return;
    }

    if (dataCb.startsWith("wd_act:")) {
        if (userId !== config.ADMIN_ID) return;
        const parts = dataCb.split(":");
        const action = parts[1];
        const targetId = parseInt(parts[2]);
        const amount = parseFloat(parts[3]);
        if (action === "apr") {
            await tg.tgEdit(chatId, menuMsgId, `✅ Approved $${amount}`);
            await tg.tgSend(targetId, `<b>✅ Withdraw Anda Sukses!</b>`);
        } else {
            const profiles = db.loadProfiles();
            if (profiles[String(targetId)]) { profiles[String(targetId)].balance += amount; db.saveProfiles(profiles); }
            await tg.tgEdit(chatId, menuMsgId, `❌ Cancelled $${amount}`);
            await tg.tgSend(targetId, "❌ Withdraw dibatalkan Admin.");
        }
        return;
    }
}

module.exports = { processCallback };
