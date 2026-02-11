const config = require('../config');
const db = require('../helpers/database');
const tg = require('../helpers/telegram');
const { state } = require('../helpers/state');

// 🔥 helper: hapus pesan user & bot lama
async function clearMessages(chatId, userMsgId) {
    try {
        // hapus pesan user
        if (userMsgId) {
            await tg.tgDelete(chatId, userMsgId).catch(() => {});
        }

        // hapus pesan bot sebelumnya
        if (state.lastBotMessage[chatId]) {
            await tg.tgDelete(chatId, state.lastBotMessage[chatId]).catch(() => {});
            delete state.lastBotMessage[chatId];
        }
    } catch (e) {
        console.log("Delete message error:", e.message);
    }
}

// simpan message_id bot terakhir
function saveBotMessage(chatId, msgId) {
    if (msgId) {
        state.lastBotMessage[chatId] = msgId;
    }
}

// ========================= ADD RANGE =========================
async function handleAddRange(userId, text, pMsgId, userMsgId) {
    await clearMessages(userId, userMsgId);

    const newRanges = [];
    const lines = text.trim().split('\n');

    lines.forEach(line => {
        if (line.includes(' > ')) {
            const parts = line.split(' > ');
            const rangeP = parts[0].trim();
            const countryN = parts[1].trim().toUpperCase();
            const serviceN = parts.length > 2 ? parts[2].trim().toUpperCase() : "WA";
            const emoji = config.COUNTRY_EMOJI[countryN] || "🗺️";
            newRanges.push({ range: rangeP, country: countryN, emoji: emoji, service: serviceN });
        }
    });

    let resultMsgId;
    if (newRanges.length > 0) {
        const current = db.loadInlineRanges();
        current.push(...newRanges);
        db.saveInlineRanges(current);
        // tgEdit sekarang mengembalikan boolean atau undefined, kita ambil pMsgId sebagai ID terakhir
        await tg.tgEdit(userId, pMsgId, `✅ Berhasil menyimpan ${newRanges.length} range baru.`);
        resultMsgId = pMsgId;
    } else {
        await tg.tgEdit(userId, pMsgId, "❌ Format tidak valid.");
        resultMsgId = pMsgId;
    }

    saveBotMessage(userId, resultMsgId);
}

// ========================= BROADCAST =========================
async function handleBroadcast(userId, chatId, text, pMsgId, userMsgId) {
    await clearMessages(chatId, userMsgId);

    if (text.trim().toLowerCase() === ".batal") {
        await tg.tgEdit(chatId, pMsgId, "❌ Siaran dibatalkan.");
    } else {
        await tg.tgEdit(chatId, pMsgId, "✅ Memulai siaran...");
        await tg.tgBroadcast(text, userId);
    }

    saveBotMessage(chatId, pMsgId);
}

// ========================= LIST USERS =========================
async function handleListUsers(userId, userMsgId) {
    await clearMessages(userId, userMsgId);

    const profiles = db.loadProfiles();

    if (Object.keys(profiles).length === 0) {
        const msgId = await tg.tgSend(userId, "❌ Belum ada data user.");
        saveBotMessage(userId, msgId);
        return;
    }

    let chunk = "";
    let count = 0;
    let lastSentId;

    for (const [uid, pdata] of Object.entries(profiles)) {
        chunk += `👤 Name: ${pdata.name || 'Unknown'}\n🧾 Dana: ${pdata.dana || '-'}\n💰 Balance: $${(pdata.balance || 0).toFixed(6)}\n📊 Total OTP: ${pdata.otp_semua || 0}\n\n`;
        count++;

        if (count % 10 === 0) {
            lastSentId = await tg.tgSend(userId, chunk);
            chunk = "";
            await new Promise(r => setTimeout(r, 400));
        }
    }

    if (chunk) {
        lastSentId = await tg.tgSend(userId, chunk);
    }
    
    // Simpan ID pesan terakhir agar bisa dihapus otomatis nanti
    saveBotMessage(userId, lastSentId);
}

module.exports = {
    handleAddRange,
    handleBroadcast,
    handleListUsers
};
