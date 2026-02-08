const config = require('../config');
const db = require('../helpers/database');
const tg = require('../helpers/telegram');
const { state } = require('../helpers/state');
const scraper = require('../helpers/scraper');

/**
 * Menghasilkan keyboard inline dari daftar range yang ada di database
 */
function generateInlineKeyboard(ranges) {
    const keyboard = [];
    ranges.forEach(item => {
        const service = item.service || "WA";
        const text = `${item.emoji || '🌐'} ${item.country || 'Unknown'} ${service}`;
        const callbackData = `select_range:${item.range}`;
        keyboard.push([{ text: text, callback_data: callbackData }]);
    });
    keyboard.push([{ text: "INPUT MANUAL RANGE..🖊️", callback_data: "manual_range" }]);
    return { inline_keyboard: keyboard };
}

/**
 * Fungsi utama pengolah klik tombol (Callback Query)
 */
async function processCallback(cq) {
    const userId = cq.from.id;
    const dataCb = cq.data;
    const callbackQueryId = cq.id; // ID unik untuk menjawab callback
    const chatId = cq.message.chat.id;
    const menuMsgId = cq.message.message_id;
    const firstName = cq.from.first_name || "User";
    const usernameTg = cq.from.username;
    const mention = usernameTg ? `@${usernameTg}` : `<a href='tg://user?id=${userId}'>${firstName}</a>`;

    // 1. WAJIB: Menjawab Callback Query agar ikon loading/jam pasir hilang di Telegram user
    try {
        await tg.tgAnswerCallback(callbackQueryId);
    } catch (e) {
        console.error("[ERROR] Gagal menjawab callback:", e.message);
    }

    // ==== AKSI: VERIFY ====
    if (dataCb === "verify") {
        if (!(await tg.isUserInBothGroups(userId))) {
            const kb = {
                inline_keyboard: [
                    [{ text: "📌 Gabung Grup 1", url: config.GROUP_LINK_1 }],
                    [{ text: "📌 Gabung Grup 2", url: config.GROUP_LINK_2 }],
                    [{ text: "✅ Verifikasi Ulang", callback_data: "verify" }]
                ]
            };
            await tg.tgEdit(chatId, menuMsgId, "❌ <b>Gagal Verifikasi!</b>\n\nAnda belum bergabung di kedua grup wajib. Silahkan gabung terlebih dahulu.", kb);
        } else {
            // Tambahkan ke state memory dan database
            state.verifiedUsers.add(userId);
            db.saveUsers(userId);
            
            const prof = db.getUserProfile(userId, firstName);
            const fullName = usernameTg ? `${firstName} (@${usernameTg})` : firstName;
            const msgProfile = `✅ <b>Verifikasi Berhasil, ${mention}</b>\n\n` +
                `👤 <b>Profil Anda :</b>\n` +
                `🔖 <b>Nama</b> : ${fullName}\n` +
                `🧾 <b>Dana</b> : ${prof.dana}\n` +
                `👤 <b>A/N</b> : ${prof.dana_an}\n` +
                `📊 <b>Total Semua OTP</b> : ${prof.otp_semua}\n` +
                `📊 <b>OTP Hari Ini</b> : ${prof.otp_hari_ini}\n` +
                `💰 <b>Saldo (Balance)</b> : $${prof.balance.toFixed(6)}\n`;
            
            const kb = {
                inline_keyboard: [
                    [{ text: "📲 Get Number", callback_data: "getnum" }, { text: "👨‍💼 Admin", url: "https://t.me/" + config.ADMIN_USERNAME }],
                    [{ text: "💸 Withdraw Money", callback_data: "withdraw_menu" }]
                ]
            };
            await tg.tgEdit(chatId, menuMsgId, msgProfile, kb);
        }
        return;
    }

    // ==== AKSI: GET NUMBER ====
    if (dataCb === "getnum") {
        if (!state.verifiedUsers.has(userId)) {
            await tg.tgEdit(chatId, menuMsgId, "⚠️ Harap verifikasi diri anda terlebih dahulu dengan menekan tombol verifikasi.");
            return;
        }
        const ranges = db.loadInlineRanges();
        const kb = ranges.length > 0 ? generateInlineKeyboard(ranges) : { inline_keyboard: [[{ text: "✍️ Input Manual Range", callback_data: "manual_range" }]] };
        await tg.tgEdit(chatId, menuMsgId, "<b>Get Number</b>\n\nSilahkan pilih range yang tersedia atau input manual di bawah ini:", kb);
        return;
    }

    // ==== AKSI: MANUAL RANGE ====
    if (dataCb === "manual_range") {
        if (!state.verifiedUsers.has(userId)) return;
        state.manualRangeInput.add(userId);
        await tg.tgEdit(chatId, menuMsgId, "<b>Input Manual Range</b>\n\nKirim Range anda sekarang melalui chat.\nContoh: <code>2327600XXX</code>");
        state.pendingMessage[userId] = menuMsgId;
        return;
    }

    // ==== AKSI: SELECT RANGE ====
    if (dataCb.startsWith("select_range:")) {
        if (!state.verifiedUsers.has(userId)) return;
        const prefix = dataCb.split(":")[1];
        const msgText = scraper.getProgressMessage(prefix, 1);
        await tg.tgEdit(chatId, menuMsgId, msgText);
        // Memulai proses scraping
        scraper.processUserInput(userId, prefix, 1, usernameTg, firstName, menuMsgId);
        return;
    }

    // ==== AKSI: CHANGE NUMBER ====
    if (dataCb.startsWith("change_num:")) {
        if (!state.verifiedUsers.has(userId)) return;
        const parts = dataCb.split(":");
        const numFetch = parseInt(parts[1]);
        const prefix = parts[2];
        await tg.tgDelete(chatId, menuMsgId);
        scraper.processUserInput(userId, prefix, numFetch, usernameTg, firstName);
        return;
    }

    // ==== AKSI: WITHDRAW MENU ====
    if (dataCb === "withdraw_menu") {
        const prof = db.getUserProfile(userId, firstName);
        const msgWd = `<b>💸 Withdraw Money</b>\n\nSilahkan pilih jumlah yang ingin ditarik:\n\n🧾 Akun Dana: <code>${prof.dana}</code>\n👤 Atas Nama: <code>${prof.dana_an}</code>\n💰 Saldo Anda: $${prof.balance.toFixed(6)}\n\n<i>Minimal Withdraw: $${config.MIN_WD_AMOUNT.toFixed(6)}</i>`;
        const kbWd = {
            inline_keyboard: [
                [{ text: "$1.000000", callback_data: "wd_req:1.0" }, { text: "$2.000000", callback_data: "wd_req:2.0" }],
                [{ text: "$3.000000", callback_data: "wd_req:3.0" }, { text: "$5.000000", callback_data: "wd_req:5.0" }],
                [{ text: "⚙️ Pengaturan Dana", callback_data: "set_dana_cb" }],
                [{ text: "🔙 Kembali", callback_data: "verify" }]
            ]
        };
        await tg.tgEdit(chatId, menuMsgId, msgWd, kbWd);
        return;
    }

    // ==== AKSI: SET DANA ====
    if (dataCb === "set_dana_cb") {
        state.waitingDanaInput.add(userId);
        await tg.tgEdit(chatId, menuMsgId, "Silahkan kirim detail akun Dana anda dalam format:\n\n<code>Nomor Dana\nNama Pemilik</code>\n\nContoh:\n<code>0812345678\nBudi Santoso</code>");
        return;
    }

    // ==== AKSI: REQUEST WITHDRAW ====
    if (dataCb.startsWith("wd_req:")) {
        const amount = parseFloat(dataCb.split(":")[1]);
        const profiles = db.loadProfiles();
        const prof = profiles[String(userId)];

        if (!prof || prof.dana === "Belum Diset") {
            await tg.tgSend(chatId, "❌ <b>Gagal!</b>\nHarap atur nomor Dana anda terlebih dahulu di menu pengaturan.");
            return;
        }
        if (prof.balance < amount) {
            await tg.tgSend(chatId, `❌ <b>Saldo Tidak Cukup!</b>\nSaldo anda saat ini hanya: $${prof.balance.toFixed(6)}`);
            return;
        }

        // Potong saldo sementara
        prof.balance -= amount;
        db.saveProfiles(profiles);

        const msgAdmin = `<b>🔔 NOTIF WITHDRAW USER</b>\n\n👤 User: ${mention}\n🆔 ID: <code>${userId}</code>\n💵 Jumlah: <b>$${amount.toFixed(6)}</b>\n🧾 Dana: <code>${prof.dana}</code>\n👤 A/N: <code>${prof.dana_an}</code>`;
        const kbAdmin = {
            inline_keyboard: [[
                { text: "✅ Approve", callback_data: `wd_act:apr:${userId}:${amount}` },
                { text: "❌ Cancel", callback_data: `wd_act:cncl:${userId}:${amount}` }
            ]]
        };
        
        await tg.tgSend(config.ADMIN_ID, msgAdmin, kbAdmin);
        await tg.tgEdit(chatId, menuMsgId, "✅ <b>Permintaan Withdraw Terkirim!</b>\nMohon tunggu proses verifikasi dari Admin.");
        return;
    }

    // ==== AKSI: ADMIN APPROVAL WD ====
    if (dataCb.startsWith("wd_act:")) {
        if (userId.toString() !== config.ADMIN_ID.toString()) return;
        const parts = dataCb.split(":");
        const action = parts[1];
        const targetId = parseInt(parts[2]);
        const amount = parseFloat(parts[3]);

        if (action === "apr") {
            await tg.tgEdit(chatId, menuMsgId, `✅ Withdraw User <code>${targetId}</code> sebesar $${amount} telah <b>DISETUJUI</b>.`);
            const prof = db.getUserProfile(targetId);
            await tg.tgSend(targetId, `<b>✅ Withdraw Berhasil!</b>\n\nDana sebesar $${amount.toFixed(6)} telah dikirim ke akun anda.\n💰 Saldo sisa: $${prof.balance.toFixed(6)}`);
        } else if (action === "cncl") {
            const profiles = db.loadProfiles();
            if (profiles[String(targetId)]) {
                // Kembalikan saldo karena dibatalkan
                profiles[String(targetId)].balance += amount;
                db.saveProfiles(profiles);
            }
            await tg.tgEdit(chatId, menuMsgId, `❌ Withdraw User <code>${targetId}</code> sebesar $${amount} telah <b>DIBATALKAN</b>.`);
            await tg.tgSend(targetId, "❌ <b>Withdraw Dibatalkan</b>\nAdmin menolak permintaan withdraw anda. Saldo telah dikembalikan. Silahkan hubungi admin untuk informasi lebih lanjut.");
        }
        return;
    }
}

module.exports = { processCallback };
