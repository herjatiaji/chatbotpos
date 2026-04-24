import sql from './db.js';

async function testConnection() {
    try {
        console.log("Mencoba terhubung ke Supabase dengan postgres.js...");
        
        // Contoh 1: Query statis standar
        const result = await sql`SELECT store_name, location FROM stores`;
        
        console.log("✅ Koneksi Berhasil!");
        console.log("Daftar Toko:");
        console.table(result); // Tampilkan tabel

        // Contoh 2: Simulasi mengeksekusi String SQL dari Gemini
        console.log("\n--- Simulasi AI Text-to-SQL ---");
        const stringDariGemini = "SELECT item_name, current_stock FROM inventory WHERE store_id = 1";
        
        // WAJIB gunakan sql.unsafe() jika query berasal dari teks String dinamis
        const resultAI = await sql.unsafe(stringDariGemini);
        
        console.log("Hasil query dari String AI:");
        console.table(resultAI);

    } catch (error) {
        console.error("❌ Koneksi Gagal:", error);
    } finally {
        // Tutup koneksi agar terminal tidak menggantung
        await sql.end();
    }
}

testConnection();