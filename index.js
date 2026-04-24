import 'dotenv/config';
import sql from './db.js';
import readline from 'readline';

// Setup antarmuka Terminal (CLI)
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Fungsi memanggil Gemini API (Dengan Auto-Retry Anti-Overload)
// Fungsi memanggil Gemini API (Dengan Auto-Retry yang Sempurna)
async function callGemini(promptText, retries = 3, delay = 2000) {
    const modelName = 'gemini-2.5-flash'; 

    if (!process.env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY kosong!");
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: promptText }] }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 2048,
                    }
                })
            });

            if (!response.ok) {
                const errorDetail = await response.text();
                // Jika server overload
                if (response.status === 503 || response.status === 429) {
                    console.log(`   [⚠️ Server sibuk. Mencoba ulang dalam ${delay/1000} detik... (Percobaan ${i+1}/${retries})]`);
                    
                    // JIKA INI PERCOBAAN TERAKHIR, LEMPAR ERROR (Jangan continue)
                    if (i === retries - 1) {
                        throw new Error("Server AI sedang overload parah. Mohon coba lagi dalam beberapa menit.");
                    }
                    
                    await new Promise(res => setTimeout(res, delay));
                    delay *= 2; 
                    continue; 
                }
                throw new Error(`Google API Error (${response.status}): ${errorDetail}`);
            }
            
            const data = await response.json();
            return data.candidates[0].content.parts[0].text.trim();

        } catch (error) {
            // Tangkap dan lempar error agar tidak me-return undefined
            if (i === retries - 1) throw error;
        }
    }
}

// ==========================================
// MAIN APP LOGIC
// ==========================================
async function startApp() {
    console.log("=========================================");
    console.log("🚀 CAFE AI ANALYST (LOCAL CLI) AKTIF");
    console.log("=========================================\n");

    // 1. Simulasi Login WhatsApp (Cek Nomor)
    rl.question('📲 Masukkan Nomor WA Anda (contoh: 62811111111): ', async (phoneNumber) => {
        
        try {
            // Cek apakah nomor terdaftar di database
            const userCheck = await sql`
                SELECT u.owner_name, u.store_id, s.store_name 
                FROM whatsapp_users u 
                JOIN stores s ON u.store_id = s.id 
                WHERE u.phone_number = ${phoneNumber}
            `;

            if (userCheck.length === 0) {
                console.log("❌ Maaf, nomor Anda tidak terdaftar dalam sistem.");
                process.exit();
            }

            const activeUser = userCheck[0];
            console.log(`\n✅ Login Sukses!`);
            console.log(`👤 Owner  : ${activeUser.owner_name}`);
            console.log(`🏪 Toko   : ${activeUser.store_name} (Store ID: ${activeUser.store_id})\n`);
            console.log("Ketik 'exit' untuk menutup aplikasi.\n");

            // 2. System Prompt Dinamis (Keamanan & Skema Ketat)
            const SYSTEM_PROMPT = `
Kamu adalah AI Data Analyst operasional Cafe.
Database PostgreSQL memiliki skema ketat berikut (HANYA GUNAKAN KOLOM INI):
1. stores (id, store_name, location)
2. menu_categories (id, store_id, name)
3. menu_items (id, store_id, category_id, name, price)
4. inventory (id, store_id, item_name, unit, current_stock)
5. menu_recipes (id, menu_item_id, inventory_id, qty_used)
6. transactions (id, store_id, receipt_number, order_type, table_number, transaction_date, total_amount, payment_method)
7. transaction_details (id, transaction_id, menu_item_id, qty, subtotal, notes)

ATURAN KEAMANAN & JOIN:
- User adalah owner store_id = ${activeUser.store_id}. WAJIB sertakan filter: transactions.store_id = ${activeUser.store_id} atau inventory.store_id = ${activeUser.store_id} di SETIAP query.
- Gunakan JOIN yang tepat, misalnya: transaction_details.transaction_id = transactions.id

ATURAN OUTPUT (SANGAT PENTING):
1. Kembalikan HANYA teks query SQL PostgreSQL mentah.
2. JANGAN gunakan markdown (\`\`\`sql) atau format apapun.
3. TULIS SELURUH QUERY DALAM SATU BARIS (Single Line) saja tanpa enter/line break.
4. Akhiri query dengan titik koma (;).

Gunakan CURRENT_DATE untuk referensi hari ini (Anggap saat ini bulan April 2026).`;

            // 3. Loop Percakapan Chatbot
            const askQuestion = () => {
                rl.question(`💬 Chat [${activeUser.owner_name}]: `, async (userInput) => {
                    if (userInput.toLowerCase() === 'exit') {
                        await sql.end();
                        rl.close();
                        console.log("Sistem dimatikan.");
                        return;
                    }

                    try {
                        // A. Natural Language ke SQL
                        console.log("   [⏳ AI sedang membuat query...]");
                        const promptToSQL = `${SYSTEM_PROMPT}\n\nPertanyaan Owner: "${userInput}"\nQuery SQL:`;
                        
                        let sqlQuery = await callGemini(promptToSQL);
                        
                        // BEST PRACTICE: Bersihkan markdown secara paksa dengan Regex
                        sqlQuery = sqlQuery.replace(/```sql/ig, '').replace(/```/g, '').trim();
                        
                        console.log("   [💻 Executing SQL]:\n", sqlQuery);

                        // B. Eksekusi Query ke Supabase
                        const dbResult = await sql.unsafe(sqlQuery);    

                        // C. SQL Result ke Natural Language
                        console.log("   [⏳ AI sedang menyusun jawaban...]");
                        const promptToSummary = `
Kamu adalah asisten Cafe yang pintar bernama Tantri. 
Berdasarkan pertanyaan owner dan data JSON mentah berikut, berikan jawaban kasual, ramah, dan berikan insight singkat.
Pertanyaan: "${userInput}"
Data DB: ${rawData}
Jawaban Anda:`;
                        
                        const finalAnswer = await callGemini(promptToSummary);
                        console.log(`\n🤖 Bot Kopi Wilwatikta:\n${finalAnswer}\n`);
                        console.log("--------------------------------------------------");

                    } catch (error) {
                        console.error("\n❌ Terjadi kesalahan query/AI:", error.message);
                        console.log("Coba ubah susunan kalimat pertanyaan Anda.\n");
                    }

                    askQuestion(); // Ulangi chat
                });
            };

            askQuestion();

        } catch (err) {
            console.error("Database Error:", err);
            process.exit();
        }
    });
}

startApp();