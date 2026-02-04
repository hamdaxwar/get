const tg = require('./helpers/telegram');

async function performLogin(page, email, password, loginUrl) {
    try {
        console.log("[BROWSER] Membuka halaman login...");
        
        // Gunakan networkidle2 (menunggu koneksi internet stabil)
        await page.goto(loginUrl, { 
            waitUntil: 'networkidle2', 
            timeout: 60000 
        });

        // Jeda tambahan untuk render JavaScript di Termux
        await new Promise(r => setTimeout(r, 5000));

        // --- VALIDASI SELECTOR ---
        console.log("[BROWSER] Mencari input form...");
        try {
            // Tunggu selector berdasarkan name sesuai HTML yang kamu kirim
            await page.waitForSelector("input[name='email']", { timeout: 15000 });
        } catch (e) {
            // Jika gagal, ambil screenshot untuk investigasi
            await page.screenshot({ path: 'login_error.png' });
            if (process.env.ADMIN_ID) {
                await tg.tgSendPhoto(process.env.ADMIN_ID, 'login_error.png', "❌ Selector email tidak ditemukan. Cek screenshot!").catch(()=>{});
            }
            throw new Error("Selector input[name='email'] tidak ditemukan");
        }

        // --- PROSES INPUT ---
        console.log("[BROWSER] Memasukkan kredensial...");
        
        // Klik dan bersihkan field email
        await page.click("input[name='email']", { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type("input[name='email']", email, { delay: 50 });

        // Klik dan bersihkan field password
        await page.click("input[name='password']", { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type("input[name='password']", password, { delay: 50 });

        // Klik tombol Sign In
        console.log("[BROWSER] Menekan tombol Sign In...");
        await Promise.all([
            page.click("button[type='submit']"),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
        ]);

        // Beri waktu setelah redirect
        await new Promise(r => setTimeout(r, 5000));

        // Cek apakah login berhasil dengan melihat URL atau element dashboard
        const currentUrl = page.url();
        if (currentUrl.includes('login')) {
            console.log("[BROWSER] Login gagal (Masih di halaman login).");
            return false;
        }

        console.log("[BROWSER] Login Berhasil. URL saat ini:", currentUrl);
        return true;

    } catch (err) {
        console.error("[LOGIN ERROR]", err.message);
        return false;
    }
}

module.exports = { performLogin };
