/**
 * Fungsi untuk menangani proses login dan navigasi paksa ke halaman GetNum
 * @param {import('playwright').Page} page 
 * @param {string} email 
 * @param {string} password 
 * @param {string} loginUrl 
 */
async function performLogin(page, email, password, loginUrl) {
    console.log("[BROWSER] Membuka halaman login...");
    await page.goto(loginUrl, { waitUntil: 'load', timeout: 60000 });
    
    // TUNGGU CHROMIUM TERBUKA SEMPURNA SELAMA 2 DETIK
    console.log("[BROWSER] Menunggu stabilitas browser (2 detik)...");
    await new Promise(r => setTimeout(r, 2000));

    // Tunggu input muncul berdasarkan selector DevTools asli
    await page.waitForSelector("input[type='email']", { state: 'visible', timeout: 30000 });
    
    console.log("[BROWSER] Mengisi email dan password...");
    await page.fill("input[type='email']", email); 
    await page.fill("input[type='password']", password);
    
    console.log("[BROWSER] Menekan tombol Sign In...");
    const loginBtn = page.locator("button[type='submit']");
    await loginBtn.click();

    // TUNGGU 3 DETIK SETELAH KLIK SUBMIT (PROSES LOGIN DI BELAKANG LAYAR)
    console.log("[BROWSER] Menunggu proses login selesai (3 detik)...");
    await new Promise(r => setTimeout(r, 3000));

    // PAKSA REDIRECT LANGSUNG KE GETNUM
    console.log("[BROWSER] Melakukan navigasi paksa ke: https://stexsms.com/mdashboard/getnum");
    await page.goto("https://stexsms.com/mdashboard/getnum", { 
        waitUntil: 'networkidle', 
        timeout: 60000 
    });

    // Verifikasi apakah sudah di halaman yang benar
    try {
        await page.waitForSelector("input[name='numberrange']", { state: 'visible', timeout: 15000 });
        console.log("[BROWSER] KONFIRMASI: Berhasil berada di halaman GetNum.");
    } catch (e) {
        console.log("[BROWSER] Peringatan: Input range tidak ditemukan, mencoba refresh halaman...");
        await page.reload({ waitUntil: 'networkidle' });
    }
}

module.exports = { performLogin };