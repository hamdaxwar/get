const dotenv = require('dotenv');
const path = require('path');

// Load Env
dotenv.config();

const GLOBAL_COUNTRY_EMOJI = require('./country.json');

// Validasi Env (Disederhanakan: Hapus STEX_EMAIL & STEX_PASSWORD jika tidak diperlukan lagi)
const requiredEnv = ['BOT_TOKEN', 'GROUP_ID_1', 'GROUP_ID_2', 'ADMIN_ID'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
    console.error(`[FATAL] Variabel lingkungan berikut belum lengkap: ${missingEnv.join(', ')}`);
    process.exit(1);
}

module.exports = {
    // --- TELEGRAM & ADMIN ---
    BOT_TOKEN: process.env.BOT_TOKEN,
    API_URL: `https://api.telegram.org/bot${process.env.BOT_TOKEN}`,
    GROUP_ID_1: parseInt(process.env.GROUP_ID_1),
    GROUP_ID_2: parseInt(process.env.GROUP_ID_2),
    ADMIN_ID: parseInt(process.env.ADMIN_ID),
    
    // --- MNIT NETWORK API CONFIG ---
    MNIT_API_KEY: "M_W17E9N1DD",
    GET_NUM_URL: "https://x.mnitnetwork.com/mapi/v1/public/getnum/number",
    CHECK_OTP_URL: "https://x.mnitnetwork.com/mapi/v1/public/numsuccess/info",

    // --- LINKS ---
    BOT_USERNAME_LINK: "https://t.me/myzuraisgoodbot",
    GROUP_LINK_1: "https://t.me/+E5grTSLZvbpiMTI1",
    GROUP_LINK_2: "https://t.me/zura14g",
    ADMIN_TELE_LINK: "https://t.me/Imr1d",

    // --- SETTINGS ---
    COUNTRY_EMOJI: GLOBAL_COUNTRY_EMOJI,

    // --- FILE PATHS ---
    FILES: {
        USER: "user.json",
        CACHE: "cache.json",
        INLINE_RANGE: "inline.json",
        WAIT: "wait.json",
        AKSES_GET10: "aksesget10.json",
        PROFILE: "profile.json",
        OTP_CACHE: "otp_cache.json", // File cache untuk monitor SMS
        SMC_LOG: "smc.json"          // File log untuk SMS masuk
    },

    BAR: {
        MAX_LENGTH: 12,
        FILLED: "█",
        EMPTY: "░"
    },

    // --- STATUS MAP (Disesuaikan untuk sistem API) ---
    STATUS_MAP: {
        0: "Menghubungkan ke API server...",
        1: "Mengirim permintaan nomor...",
        2: "Menunggu alokasi nomor dari provider...",
        3: "Memproses detail nomor...",
        4: "Nomor berhasil didapatkan!",
        5: "Selesai."
    }
};
