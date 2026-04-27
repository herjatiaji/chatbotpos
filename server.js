import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import sql from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// MULTI-TENANT: Rate limiter per store
// ==========================================
const rateLimitMap = new Map();
function isRateLimited(storeId) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxRequests = 20;
    if (!rateLimitMap.has(storeId)) rateLimitMap.set(storeId, []);
    const timestamps = rateLimitMap.get(storeId).filter(t => now - t < windowMs);
    timestamps.push(now);
    rateLimitMap.set(storeId, timestamps);
    return timestamps.length > maxRequests;
}

// ==========================================
// MULTI-TENANT: Session/conversation context
// ==========================================
const sessionStore = new Map();
const MAX_HISTORY = 5;
const SESSION_TTL = 30 * 60 * 1000;

function getSession(phone) {
    const session = sessionStore.get(phone);
    if (!session) return { history: [], lastActive: Date.now() };
    if (Date.now() - session.lastActive > SESSION_TTL) {
        sessionStore.delete(phone);
        return { history: [], lastActive: Date.now() };
    }
    return session;
}

function updateSession(phone, userMsg, botMsg) {
    const session = getSession(phone);
    session.history.push({ role: 'user', content: userMsg });
    session.history.push({ role: 'assistant', content: botMsg });
    if (session.history.length > MAX_HISTORY * 2) {
        session.history = session.history.slice(-MAX_HISTORY * 2);
    }
    session.lastActive = Date.now();
    sessionStore.set(phone, session);
}

setInterval(() => {
    const now = Date.now();
    for (const [phone, session] of sessionStore.entries()) {
        if (now - session.lastActive > SESSION_TTL) sessionStore.delete(phone);
    }
}, 10 * 60 * 1000);

// ==========================================
// SECURITY: Validasi SQL dari AI
// ==========================================
const FORBIDDEN_SQL_KEYWORDS = [
    /\bDROP\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i,
    /\bALTER\b/i, /\bTRUNCATE\b/i, /\bCREATE\b/i, /\bGRANT\b/i,
    /\bREVOKE\b/i, /\bEXECUTE\b/i, /\bpg_sleep\b/i, /\bpg_read_file\b/i,
];

function validateSQL(sqlQuery, storeId) {
    for (const pattern of FORBIDDEN_SQL_KEYWORDS) {
        if (pattern.test(sqlQuery)) throw new Error('SQL tidak aman: mengandung keyword terlarang.');
    }
    if (!/^\s*(?:WITH\s+\w|SELECT\s)/i.test(sqlQuery)) {
        throw new Error('SQL tidak aman: hanya SELECT atau CTE yang diizinkan.');
    }
    const storeIdPattern = new RegExp(`store_id\\s*=\\s*${storeId}(?!\\d)`);
    if (!storeIdPattern.test(sqlQuery)) {
        throw new Error(`SQL tidak aman: tidak ada filter store_id = ${storeId}.`);
    }
}

// ==========================================
// 🔥 AI ENGINE (Llama 4 Maverick via NATIVE FETCH)
// ==========================================
async function callAI(promptText, enableThinking = false, retries = 3, delay = 5000) {
    if (!process.env.NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY kosong!');

    const invokeUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
    const headers = {
        "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
        "Accept": "text/event-stream",
        "Content-Type": "application/json"
    };

    const payload = {
        "model": "meta/llama-4-maverick-17b-128e-instruct",
        "messages": [{"role": "user", "content": promptText}],
        "max_tokens": 4096,
        "temperature": enableThinking ? 0.6 : 0.1,
        "top_p": 0.95,
        "stream": true
    };

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(invokeUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const isOverload = response.status === 503 || response.status === 429;
                if (i === retries - 1 || !isOverload) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
                continue;
            }

            // Membaca stream menggunakan Web Streams API
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let fullContent = '';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                
                // Simpan baris terakhir ke buffer karena mungkin belum komplit
                buffer = lines.pop();

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.substring(6).trim();
                        if (dataStr === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(dataStr);
                            if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) {
                                fullContent += parsed.choices[0].delta.content;
                            }
                        } catch (e) {
                            // Abaikan error parsing JSON stream yang terpotong
                        }
                    }
                }
            }

            return fullContent.trim();

        } catch (error) {
            console.log(`   [⚠️ API Error] Percobaan ${i + 1}/${retries}: ${error.message}`);
            if (i === retries - 1) throw new Error('Gagal menghubungi server AI.');
            await new Promise(res => setTimeout(res, delay));
            delay *= 2;
        }
    }
}

// ==========================================
// HELPER: Ambil rentang data transaksi
// ==========================================
async function getDataRange(storeId) {
    try {
        const result = await sql`
            SELECT 
                MIN(transaction_date)::date AS tanggal_pertama,
                MAX(transaction_date)::date AS tanggal_terakhir,
                COUNT(*) AS total_transaksi
            FROM transactions WHERE store_id = ${storeId}
        `;
        return result[0];
    } catch { return null; }
}

// ==========================================
// HELPER: Deteksi chitchat
// ==========================================
function isChitchat(message) {
    const patterns = [
        /^halo/i, /^hai/i, /^hi\b/i, /^hey/i,
        /^apa kabar/i, /^selamat/i, /^terima kasih/i, /^makasih/i,
        /^siapa kamu/i, /^kamu itu/i, /^bisa apa/i, /^help\b/i, /^bantuan/i,
    ];
    return patterns.some(p => p.test(message.trim()));
}

// ==========================================
// HELPER: Deteksi apakah pesan adalah nota/struk
// ==========================================
function isNota(message) {
    const notaPatterns = [
        /nota[:\s]/i,
        /struk[:\s]/i,
        /receipt[:\s]/i,
        /baca\s+nota/i,
        /input\s+nota/i,
        /catat\s+nota/i,
        /\d+\s*[xX]\s*\d+/,
        /rp\.?\s*\d{3,}/i,
    ];
    return notaPatterns.some(p => p.test(message.trim()));
}

// ==========================================
// PARSER NOTA: Ekstrak item dari teks nota
// ==========================================
async function parseNota(notaText, storeId) {
    const prompt = `
Kamu adalah parser nota/struk belanja yang akurat.
Tugasmu: ekstrak semua item dari teks nota berikut dan kembalikan HANYA JSON array.

Format JSON yang WAJIB dikembalikan (tanpa markdown, tanpa penjelasan):
[
  {
    "nama_item": "nama barang",
    "qty": angka,
    "harga_satuan": angka,
    "subtotal": angka,
    "kategori_perkiraan": "bahan_baku | menu | operasional | lainnya"
  }
]

Aturan:
- Jika qty tidak disebutkan, asumsikan 1
- Jika harga satuan tidak ada tapi subtotal ada, hitung: harga_satuan = subtotal / qty
- Jika subtotal tidak ada, hitung: subtotal = qty * harga_satuan
- Buang karakter mata uang (Rp, IDR) dari angka
- kategori_perkiraan: tebak berdasarkan nama item (kopi/gula/susu = bahan_baku, dll)
- Kembalikan array kosong [] jika tidak ada item yang bisa diekstrak

Teks nota:
${notaText}

JSON:`;

    const result = await callAI(prompt, false);
    try {
        const cleaned = result.replace(/```json/ig, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
    } catch {
        return [];
    }
}

// ==========================================
// HELPER: Deteksi apakah pertanyaan tentang HPP
// ==========================================
function isHPPQuestion(message) {
    const hppPatterns = [
        /\bhpp\b/i,
        /harga\s+pokok/i,
        /cost\s+of\s+goods/i,
        /biaya\s+produksi/i,
        /margin\s+(kotor|bersih|keuntungan)/i,
        /keuntungan\s+(kotor|bersih|per\s+menu)/i,
        /berapa\s+(untung|profit|margin)/i,
        /profit\s+margin/i,
        /mark.?up/i,
    ];
    return hppPatterns.some(p => p.test(message.trim()));
}

// ==========================================
// HPP CALCULATOR
// ==========================================
async function hitungHPP(storeId, menuKeyword = null) {
    const menuFilter = menuKeyword ? `AND mi.name ILIKE '%${menuKeyword}%'` : '';
    const resepData = await sql.unsafe(`
        SELECT
            mi.id       AS menu_id,
            mi.name     AS nama_menu,
            mi.price    AS harga_jual,
            inv.item_name AS bahan,
            inv.unit,
            mr.qty_used
        FROM menu_items mi
        JOIN menu_recipes mr ON mr.menu_item_id = mi.id
        JOIN inventory inv   ON inv.id = mr.inventory_id
        WHERE mi.store_id = ${storeId}
        ${menuFilter}
        ORDER BY mi.name, inv.item_name
    `);

    const hargaRef = await sql.unsafe(`
        SELECT
            inv.item_name,
            inv.unit,
            cl.amount       AS total_bayar,
            cl.description  AS keterangan,
            cl.created_at   AS tanggal_beli
        FROM cash_logs cl
        JOIN inventory inv ON cl.description ILIKE '%' || inv.item_name || '%'
        WHERE cl.store_id = ${storeId}
        AND cl.type = 'out'
        ORDER BY cl.created_at DESC
    `);

    const menuMap = {};
    for (const row of resepData) {
        if (!menuMap[row.nama_menu]) {
            menuMap[row.nama_menu] = {
                nama_menu: row.nama_menu,
                harga_jual: Number(row.harga_jual),
                bahan: []
            };
        }
        const ref = hargaRef.filter(h => h.item_name === row.bahan);
        menuMap[row.nama_menu].bahan.push({
            nama: row.bahan,
            qty_used: Number(row.qty_used),
            unit: row.unit,
            referensi_harga_dari_cashlog: ref.length > 0
                ? ref.slice(0, 2).map(r => ({
                    total_bayar: Number(r.total_bayar),
                    keterangan: r.keterangan,
                    tanggal: r.tanggal_beli
                  }))
                : null
        });
    }

    return Object.values(menuMap);
}

// ==========================================
// API ENDPOINT — MAIN CHAT
// ==========================================
app.post('/api/chat', async (req, res) => {
    const { message, phone } = req.body;

    if (!message || !phone) {
        return res.status(400).json({ success: false, answer: "Parameter 'message' dan 'phone' wajib diisi." });
    }

    try {
        console.log(`\n💬 [${phone}] "${message}"`);

        const userCheck = await sql`
            SELECT u.owner_name, u.store_id, s.store_name 
            FROM whatsapp_users u 
            JOIN stores s ON u.store_id = s.id 
            WHERE u.phone_number = ${phone}
        `;

        if (userCheck.length === 0) {
            return res.status(403).json({ success: false, answer: "Mohon maaf, nomor Anda tidak terdaftar dalam sistem Kazeer AI." });
        }

        const activeUser = userCheck[0];
        const storeId = activeUser.store_id;
        const storeName = activeUser.store_name;

        // ── Rate limiting ─────────────────────────────────────
        if (isRateLimited(storeId)) {
            return res.status(429).json({
                success: false,
                answer: "⏳ Terlalu banyak permintaan dalam waktu singkat. Silakan tunggu sebentar sebelum mencoba kembali."
            });
        }

        // ── Chitchat guard ────────────────────────────────────
        if (isChitchat(message)) {
            return res.json({
                success: true,
                answer: `🤖 Kazeer AI\n\nHalo! Saya adalah Kazeer, bot AI Business Consultant kamu untuk ${storeName}.\n\n💡 Saya bisa membantu kamu dengan:\n1. 📊 Analisis omzet & transaksi\n2. 🏆 Menu terlaris & performa penjualan\n3. 📦 Stok & bahan baku\n4. 💰 Laporan laba rugi\n5. 🧾 Baca & analisis nota belanja\n6. 📈 Hitung HPP & margin keuntungan\n\nSilakan ajukan pertanyaan bisnis kamu! 🚀`,
                sql: null,
                rawData: []
            });
        }

        const session = getSession(phone);
        const conversationHistory = session.history
            .map(h => `${h.role === 'user' ? 'Owner' : 'Kazeer'}: ${h.content}`)
            .join('\n');

        // ══════════════════════════════════════════════════════
        // 🧾 FLOW: PARSER NOTA
        // ══════════════════════════════════════════════════════
        if (isNota(message)) {
            console.log("   [🧾 Nota terdeteksi — parsing...]");
            const items = await parseNota(message, storeId);

            if (items.length === 0) {
                return res.json({
                    success: true,
                    answer: "⚠️ Maaf, saya tidak berhasil membaca nota tersebut.\n\nCoba format seperti ini:\n\nnota:\n1. Kopi Arabika 500gr x 2 = Rp 90.000\n2. Gula Pasir 1kg x 1 = Rp 15.000",
                    sql: null,
                    rawData: []
                });
            }

            const totalNota = items.reduce((sum, i) => sum + (i.subtotal || 0), 0);

            const notaPrompt = `
WAJIB: Seluruh jawaban dalam Bahasa Indonesia. DILARANG menggunakan Bahasa Inggris.

Kamu adalah Kazeer, bot AI Business Consultant yang profesional.
Kamu baru saja membaca nota belanja dari ${storeName}.

Data item yang berhasil diekstrak:
${JSON.stringify(items, null, 2)}

Total nota: Rp ${totalNota.toLocaleString('id-ID')}

Tugas kamu:
1. Tampilkan ringkasan item yang berhasil dibaca dengan format rapi + emoji
2. Tampilkan total belanja
3. Kelompokkan per kategori (bahan_baku, operasional, dll)
4. Berikan 1-2 insight bisnis singkat (apakah pengeluaran ini wajar? ada yang perlu diperhatikan?)
5. Tanyakan apakah owner ingin mencatat pengeluaran ini ke cash_logs

Format jawaban: gunakan paragraf pendek, emoji yang relevan, dan poin-poin singkat (Gunakan angka 1, 2, 3, BUKAN bullet).
WAJIB berikan jarak baris ganda (enter) antar paragraf/poin.
DILARANG menggunakan markdown bold/tanda bintang (*).
JANGAN tampilkan JSON mentah.`;

            const notaAnswer = await callAI(notaPrompt, true);
            updateSession(phone, message, notaAnswer);

            return res.json({
                success: true,
                answer: notaAnswer,
                sql: null,
                rawData: items,
                notaParsed: true
            });
        }

        // ══════════════════════════════════════════════════════
        // 📈 FLOW: HPP & MARGIN CALCULATOR
        // ══════════════════════════════════════════════════════
        if (isHPPQuestion(message)) {
            console.log("   [📈 HPP question terdeteksi — thinking mode ON...]");

            const hppData = await hitungHPP(storeId);

            const hppPrompt = `
WAJIB: Seluruh jawaban dalam Bahasa Indonesia. DILARANG menggunakan Bahasa Inggris.

Kamu adalah Kazeer, bot AI Business Consultant untuk ${storeName}.
Pertanyaan owner: "${message}"

Berikut data resep dan referensi harga bahan dari database:
${JSON.stringify(hppData, null, 2)}

CARA MENGHITUNG HPP:
- Jika "referensi_harga_dari_cashlog" tersedia → gunakan total_bayar dari sana untuk mencari harga satuan.
- HPP per bahan = (qty_used / total_qty_beli) × total_bayar.

TUGAS UTAMA:
1. FOKUS HANYA PADA MENU YANG DITANYAKAN USER. Abaikan data menu lain yang tidak relevan dengan pertanyaan!
2. 🧮 Tampilkan rincian perhitungan modal (HPP) per bahan baku khusus untuk menu tersebut.
3. 💰 Hitung margin kotornya menggunakan harga jual yang baru (jika user memberikan harga baru di pertanyaan). Rumus: ((Harga Jual - Total HPP) / Harga Jual) × 100%
4. 📊 Berikan kesimpulan apakah persentase margin tersebut sehat (Rendah <30%, Sedang 30-60%, Tinggi >60%).
5. 💡 Berikan 1 rekomendasi bisnis singkat terkait harga tersebut.

ATURAN FORMAT (SANGAT PENTING - WAJIB DIIKUTI):
- JAWABAN HARUS RAPI! WAJIB berikan ENTER (baris kosong ganda / line break) di antara setiap poin/paragraf. DILARANG menggabungkan jawaban menjadi satu paragraf panjang.
- DILARANG menggunakan tanda bintang (*) atau format bold (teks tebal) dalam jawaban.
- DILARANG menggunakan bullet • — gunakan angka (1. 2. 3.) atau susun ke bawah dengan rapi.
- Format uang wajib pakai Rupiah (Rp 15.000).
- JANGAN tampilkan teks JSON mentah.`;

            const hppAnswer = await callAI(hppPrompt, true); 
            updateSession(phone, message, hppAnswer);

            return res.json({
                success: true,
                answer: hppAnswer,
                sql: null,
                rawData: hppData,
                hppCalculated: true
            });
        }

       // ══════════════════════════════════════════════════════
        // 🧠 FLOW UTAMA: SQL → DB → ANSWER
        // ══════════════════════════════════════════════════════
        const today = new Date().toISOString().split('T')[0];

        const SYSTEM_PROMPT = `
Kamu adalah AI SQL Generator khusus untuk sistem cafe berbasis PostgreSQL.
Tugas SATU-SATUNYA: menghasilkan query SQL yang valid, aman, akurat, dan efisien.

Kamu sedang melayani: ${storeName} (store_id = ${storeId})
Hari ini: ${today}

============================
KONTEKS PERCAKAPAN SEBELUMNYA
============================
${conversationHistory || '(Tidak ada riwayat percakapan sebelumnya)'}
Gunakan konteks di atas jika pertanyaan saat ini adalah follow-up (ada kata "itu", "tadi", "lalu bagaimana", "bandingkan").

============================
PEMETAAN KATA KUNCI WAKTU
============================
| Kata kunci user                               | Filter SQL                                                                                       |
|-----------------------------------------------|--------------------------------------------------------------------------------------------------|
| "hari ini", "today"                           | t.transaction_date::date = CURRENT_DATE                                                          |
| "kemarin"                                     | t.transaction_date::date = CURRENT_DATE - INTERVAL '1 day'                                       |
| "minggu ini"                                  | DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE)                        |
| "minggu lalu"                                 | DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 week')    |
| "bulan ini"                                   | DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)                      |
| "bulan lalu"                                  | DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') |
| "tahun ini"                                   | DATE_TRUNC('year', t.transaction_date) = DATE_TRUNC('year', CURRENT_DATE)                        |
| "sekarang", "saat ini", "kini"                | DATE_TRUNC('month', ...) = DATE_TRUNC('month', CURRENT_DATE)  ← BULAN INI                        |
| "total", "keseluruhan", "semua"               | TANPA filter tanggal                                                                             |

NAMA BULAN: Jan=1 Feb=2 Mar=3 Apr=4 Mei=5 Jun=6 Jul=7 Agt=8 Sep=9 Okt=10 Nov=11 Des=12

METODE PEMBAYARAN:
tunai/cash → ILIKE '%cash%' | transfer/bank → ILIKE '%transfer%' | qris/digital/ewallet → ILIKE '%qris%'

============================
ATURAN WAJIB (BACA DENGAN TELITI)
============================
[1]  KEAMANAN: WAJIB store_id = ${storeId} pada: transactions, inventory, menu_items, menu_categories, cash_logs.
[2]  ALIAS: transactions→t | transaction_details→td | menu_items→mi | menu_categories→mc | inventory→inv | cash_logs→cl | menu_recipes→mr
[3]  NULL-SAFE: COALESCE(..., 0) pada semua agregat.
[4]  LABA/RUGI: pendapatan=SUM(t.total_amount), pengeluaran=SUM(cl.amount) WHERE cl.type='out'.
[5]  [PENTING] PENGELUARAN SPESIFIK: Jika user menanyakan "pengeluaran untuk X dan Y" (contoh: gaji, sewa, listrik), JANGAN gunakan SUM(). Kamu WAJIB menggunakan SELECT description, amount, created_at FROM cash_logs. 
[6]  [PENTING] KATA KUNCI DASAR: Gunakan akar kata saja untuk ILIKE. Contoh: jika user tanya "gaji karyawan", gunakan ILIKE '%gaji%'. Jika tanya "sewa tempat", gunakan ILIKE '%sewa%'.

============================
CONTOH QUERY (FEW-SHOT)
============================

Pertanyaan: "total pendapatan keseluruhan"
SQL: SELECT COALESCE(SUM(t.total_amount),0) AS total_pendapatan, COUNT(t.id) AS total_transaksi FROM transactions t WHERE t.store_id = ${storeId};

Pertanyaan: "5 menu terlaris bulan ini"
SQL: SELECT mi.name AS nama_menu, COALESCE(SUM(td.qty),0) AS total_porsi, COALESCE(SUM(td.subtotal),0) AS total_pendapatan FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mi.name ORDER BY total_porsi DESC LIMIT 5;

Pertanyaan: "berapa pengeluaran kita buat gaji dan sewa?"
SQL: SELECT description, amount, created_at FROM cash_logs WHERE store_id = ${storeId} AND type = 'out' AND (description ILIKE '%gaji%' OR description ILIKE '%sewa%') ORDER BY created_at DESC;

============================
FORMAT OUTPUT
============================
- Kembalikan HANYA satu baris SQL mentah. Tanpa markdown, tanpa penjelasan.
- Akhiri dengan titik koma (;).
- Jika tidak bisa dijawab: SELECT 'PERTANYAAN_TIDAK_VALID' AS status;`;

        console.log("   [⏳ Step A: Generating SQL...]");
        const promptToSQL = `${SYSTEM_PROMPT}\n\nPertanyaan: "${message}"\nQuery SQL:`;
        let sqlQuery = await callAI(promptToSQL, false);
        sqlQuery = sqlQuery.replace(/```sql/ig, '').replace(/```/g, '').trim();

        validateSQL(sqlQuery, storeId);
        console.log("   [💻 Execute SQL]:", sqlQuery);

        if (sqlQuery.includes('PERTANYAAN_TIDAK_VALID')) {
            return res.json({
                success: true,
                answer: "⚠️ Maaf, pertanyaan tersebut belum bisa dijawab dengan data yang tersedia.\n\nCoba tanyakan dengan cara yang berbeda, atau ketik *bantuan* untuk melihat contoh pertanyaan yang bisa saya jawab. 😊",
                sql: sqlQuery, rawData: []
            });
        }

        const dbResult = await sql.unsafe(sqlQuery);

        const safeData = dbResult.length > 20 ? dbResult.slice(0, 20) : dbResult;
        let dataToAI = JSON.stringify(safeData);
        if (dbResult.length > 20) {
            dataToAI += `\n(Catatan: Ditampilkan 20 data teratas dari total ${dbResult.length} baris.)`;
        }

        // Inject konteks rentang data jika kosong
        let dataRangeContext = '';
        const isEmptyOrZero = safeData.length === 0 ||
            safeData.every(row => Object.values(row).every(v => v === null || v === 0 || v === '0'));

        if (isEmptyOrZero) {
            const range = await getDataRange(storeId);
            if (range?.total_transaksi > 0) {
                dataRangeContext = `\nINFO: Database memiliki ${range.total_transaksi} transaksi dari ${range.tanggal_pertama} hingga ${range.tanggal_terakhir}. Kemungkinan kata kunci tidak ditemukan atau belum ada transaksi di periode ini.`;
            }
        }

        // 🧠 STEP C: KAZEER ANSWER GENERATOR
        console.log("   [⏳ Step C: Kazeer menyusun jawaban...]");
        const promptToSummary = `
WAJIB: Seluruh jawaban dalam Bahasa Indonesia. DILARANG menggunakan Bahasa Inggris dalam jawaban akhir.

Kamu adalah Kazeer, bot AI Business Consultant untuk ${storeName}.

Pertanyaan: "${message}"
Data dari database: ${dataToAI}${dataRangeContext}

CARA MENJAWAB (WAJIB DIIKUTI):
1. Setiap poin diawali emoji yang relevan, diikuti teks langsung
2. JAWABAN HARUS RAPI! WAJIB berikan ENTER (baris kosong ganda / line break) di antara setiap poin/paragraf.
3. [PENTING] JIKA MENDAPATKAN RINCIAN PENGELUARAN (description & amount): Kamu wajib menjumlahkannya sendiri secara matematis dan tampilkan TOTAL keseluruhannya. Lalu, berikan juga breakdown/rinciannya dari mana uang tersebut terpakai agar owner tahu detailnya.
4. Selalu akhiri dengan 1 insight bisnis yang actionable dan spesifik
5. Bahasa Indonesia yang profesional tapi santai. Gunakan sebutan "Bos" untuk menyapa user.
6. Format Rupiah: Rp 1.250.000
7. Untuk daftar: gunakan angka (1. 2. 3.) bukan bullet.

DILARANG KERAS:
- DILARANG menggunakan tanda bintang (*) atau markdown bold dalam jawaban.
- DILARANG menggunakan bullet •.
- DILARANG Menampilkan JSON mentah.`;

        const finalAnswer = await callAI(promptToSummary, true);
        updateSession(phone, message, finalAnswer);

        console.log("   [✅ Done]");
        res.json({ success: true, answer: finalAnswer, sql: sqlQuery, rawData: safeData });

    } catch (error) {
        console.error("❌ Error:", error.message);
        res.status(500).json({
            success: false,
            answer: "⚠️ Maaf, terjadi kendala teknis saat memproses permintaan kamu.\n\nSilakan coba beberapa saat lagi. 🙏",
            error: error.message
        });
    }
});

// ==========================================
// ENDPOINT: Simpan hasil parsing nota ke cash_logs
// ==========================================

app.post('/api/catat-nota', async (req, res) => {
    const { phone, items, description } = req.body;

    try {
        const userCheck = await sql`
            SELECT u.store_id FROM whatsapp_users u WHERE u.phone_number = ${phone}
        `;
        if (userCheck.length === 0) return res.status(403).json({ success: false });

        const storeId = userCheck[0].store_id;
        const total = items.reduce((sum, i) => sum + (i.subtotal || 0), 0);

        await sql`
            INSERT INTO cash_logs (store_id, type, amount, description, created_at)
            VALUES (${storeId}, 'out', ${total}, ${description || 'Pengeluaran dari nota'}, NOW())
        `;

        res.json({ success: true, message: `✅ Nota berhasil dicatat ke kas. Total: Rp ${total.toLocaleString('id-ID')}` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        app: 'Kazeer AI',
        version: '2.0.0',
        activeSessions: sessionStore.size,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════╗
║        🤖 KAZEER AI v2.0.0             ║
║        Business Consultant Bot         ║
╠════════════════════════════════════════╣
║  🔗 Port    : ${PORT}                    ║
║  👥 Mode    : Multi-Tenant             ║
║  🧠 Engine  : Llama 4 Maverick (Fetch) ║
║  📦 Features: SQL · Nota · HPP         ║
╚════════════════════════════════════════╝
    `);
});