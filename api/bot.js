const { Telegraf } = require('telegraf');
const axios = require('axios');
const tf = require('@tensorflow/tfjs-node');
const nsfwjs = require('nsfwjs');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Variables for State and Spam Tracking (Active in memory during function execution)
let botState = 'auto'; 
const spamTracker = new Map(); 
let nsfwModel = null;

// AI Model Load karna (Optimized for Vercel)
const loadModel = async () => {
    if (!nsfwModel) {
        nsfwModel = await nsfwjs.load();
    }
};

// --- Admin Commands ---
bot.command('nsfwon', (ctx) => {
    botState = 'on';
    ctx.reply('🛡️ NSFW Moderation: PERMANENT ON (Silent Killer Mode)');
});

bot.command('nsfwoff', (ctx) => {
    botState = 'off';
    ctx.reply('🛡️ NSFW Moderation: PERMANENT OFF');
});

bot.command('nsfwauto', (ctx) => {
    botState = 'auto';
    ctx.reply('🛡️ NSFW Moderation: AUTO MODE (12 AM - 6 AM IST)');
});

// --- Core Logic ---
bot.on(['photo', 'document'], async (ctx) => {
    // 1. Intelligent Time Check (IST)
    const nowIST = new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
    const hour = new Date(nowIST).getHours();
    
    let isActive = false;
    if (botState === 'on') isActive = true;
    else if (botState === 'auto') isActive = (hour >= 0 && hour < 6);

    if (!isActive) return;

    try {
        await loadModel();

        let fileId;
        // Handle both compressed photos and uncompressed documents (images)
        if (ctx.message.photo) {
            fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        } else if (ctx.message.document && ctx.message.document.mime_type.startsWith('image/')) {
            fileId = ctx.message.document.file_id;
        } else {
            return; // Not an image
        }

        const fileUrl = await ctx.telegram.getFileLink(fileId);
        const response = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(response.data);

        // Buffer to Tensor
        const decodedImage = tf.node.decodeImage(imageBuffer, 3);
        const predictions = await nsfwModel.classify(decodedImage);
        decodedImage.dispose(); // Prevent Vercel Memory Leaks

        // 2. Max Level Accuracy Check
        let isNsfw = false;
        for (const prediction of predictions) {
            // "Porn" aur "Hentai" class har type ke extreme aur illegal explicit content ko catch karti hai
            if (['Porn', 'Hentai', 'Sexy'].includes(prediction.className) && prediction.probability > 0.65) {
                isNsfw = true;
                break;
            }
        }

        // 3. Delete & Anti-Spam Logic
        if (isNsfw) {
            // Silently delete the explicit image
            await ctx.deleteMessage(ctx.message.message_id).catch(() => {});

            const userId = ctx.from.id;
            const chatId = ctx.chat.id;

            // Update user spam count
            let userStats = spamTracker.get(userId) || { count: 0 };
            userStats.count += 1;
            spamTracker.set(userId, userStats);

            // Agar 5 images se zyada spam kiya
            if (userStats.count >= 5) {
                const muteMinutes = 10;
                const untilDate = Math.floor(Date.now() / 1000) + (muteMinutes * 60);

                // Mute the user silently (requires bot to be Admin with restrict permissions)
                await ctx.telegram.restrictChatMember(chatId, userId, {
                    permissions: { can_send_messages: false },
                    until_date: untilDate
                }).catch((err) => console.log("Mute error (Bot admin nahi hai):", err));

                // Optional: Mute notification (Delete if you want 100% silence)
                const msg = await ctx.reply(`🚫 [Action taken] Ek user ko lagatar NSFW spam karne ke karan 10 minute ke liye mute kiya gaya hai.`);
                setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => {}), 5000);

                // Reset count after muting
                spamTracker.delete(userId);
            }
        }
    } catch (error) {
        console.error("Vercel AI Processing Error:", error.message);
    }
});

// --- Vercel Serverless Webhook ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body, res);
            res.status(200).send('OK');
        } else {
            res.status(200).send('Kanu Bhai Ka Bot Zinda Hai!');
        }
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).send('Server Error');
    }
};
  
