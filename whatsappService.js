import 'dotenv/config';

export async function sendWhatsAppMessage(to, body) {
    if (!process.env.WHATSAPP_TOKEN) {
        console.error("WHATSAPP_TOKEN kosong!");
        return;
    }

    if (!process.env.WHATSAPP_PHONE_NUMBER_ID) {
        console.error("WHATSAPP_PHONE_NUMBER_ID kosong!");
        return;
    }

    const url = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: to,
                text: { body: body },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`WhatsApp API Error (${response.status}): ${errorText}`);
        }

        return await response.json();
    } catch (error) {
        console.error("Gagal mengirim pesan WhatsApp:", error);
    }
}
