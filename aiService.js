import 'dotenv/config';

// Fungsi memanggil Gemini API (Dengan Auto-Retry yang Sempurna)
export async function callGemini(promptText, retries = 3, delay = 2000) {
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
