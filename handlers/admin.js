const config = require('../config');
const db = require('../helpers/database');
const tg = require('../helpers/telegram');
const { state } = require('../helpers/state');

async function handleAddRange(userId, text, pMsgId) {
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

    if (newRanges.length > 0) {
        const current = db.loadInlineRanges();
        current.push(...newRanges);
        db.saveInlineRanges(current);
        await tg.tgEdit(userId, pMsgId, `✅ Berhasil menyimpan ${newRanges.length} range baru.`);
    } else {
        await tg.tgEdit(userId, pMsgId, "❌ Format tidak valid.");
    }
}

async function handleBroadcast(userId, chatId, text, pMsgId) {
    if (text.trim().toLowerCase() === ".batal") {
        await tg.tgEdit(chatId, pMsgId, "❌ Siaran dibatalkan.");
    } else {
        await tg.tgEdit(chatId, pMsgId, "✅ Memulai siaran...");
        await tg.tgBroadcast(text, userId);
    }
}

async function handleListUsers(userId) {
    const profiles = db.loadProfiles();
    if (Object.keys(profiles).length === 0) {
        await tg.tgSend(userId, "❌ Belum ada data user.");
    } else {
        let msgList = "<b>📋 LIST SEMUA USER</b>\n\n";
        let chunk = "";
        let count = 0;
        for (const [uid, pdata] of Object.entries(profiles)) {
            chunk += `👤 Name: ${pdata.name || 'Unknown'}\n🧾 Dana: ${pdata.dana || '-'}\n💰 Balance: $${(pdata.balance || 0).toFixed(6)}\n📊 Total OTP: ${pdata.otp_semua || 0}\n\n`;
            count++;
            if (count % 10 === 0) {
                await tg.tgSend(userId, chunk);
                chunk = "";
                await new Promise(r => setTimeout(r, 500));
            }
        }
        if (chunk) await tg.tgSend(userId, chunk);
    }
}

module.exports = {
    handleAddRange,
    handleBroadcast,
    handleListUsers
};
