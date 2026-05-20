const { Telegraf } = require('telegraf');
const axios = require('axios');
const tf = require('@tensorflow/tfjs-node');
const nsfwjs = require('nsfwjs');
const sharp = require('sharp'); 

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- System States & Memory ---
let systemMode = 'auto'; // Modes: on, off, auto
const spamTracker = new Map(); 
let nsfwModel = null;

// --- Neural Network Initialization ---
const loadNeuralModel = async () => {
    if (!nsfwModel) {
        nsfwModel = await nsfwjs.load(); 
    }
};

// --- Control Directives ---
bot.command('system_on', (ctx) => { systemMode = 'on'; ctx.reply('🛡️ Defense Matrix: ACTIVE'); });
bot.command('system_off', (ctx) => { systemMode = 'off'; ctx.reply('🛡️ Defense Matrix: OFFLINE'); });
bot.command('system_auto', (ctx) => { systemMode = 'auto'; ctx.reply('🛡️ Defense Matrix: AUTO-SCHEDULE (00:00 - 06:00 IST)'); });

// --- Unified Media Processor ---
bot.on(['photo', 'document', 'sticker', 'video', 'animation'], async (ctx) => {
    
    // 1. Time Zone Validation (IST)
    const nowIST = new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
    const currentHour = new Date(nowIST).getHours();
    
    const isOperational = (systemMode === 'on') || (systemMode === 'auto' && currentHour >= 0 && currentHour < 6);
    if (!isOperational) return;

    try {
        await loadNeuralModel();

        let targetFileId = null;
        let needsFormatConversion = false;
        const payload = ctx.message;
        
        // 2. Intelligent Media Extraction
        if (payload.photo) {
            targetFileId = payload.photo[payload.photo.length - 1].file_id; 
        } 
        else if (payload.document && payload.document.mime_type?.startsWith('image/')) {
            targetFileId = payload.document.file_id; 
        } 
        else if (payload.sticker) {
            needsFormatConversion = true; 
            if (payload.sticker.is_animated || payload.sticker.is_video) {
                if (payload.sticker.thumbnail) targetFileId = payload.sticker.thumbnail.file_id;
            } else {
                targetFileId = payload.sticker.file_id;
            }
        } 
        else if (payload.video && payload.video.thumbnail) {
            targetFileId = payload.video.thumbnail.file_id; 
        } 
        else if (payload.animation && payload.animation.thumbnail) {
            targetFileId = payload.animation.thumbnail.file_id; 
        }

        if (!targetFileId) return;

        // 3. Buffer Acquisition & Format Normalization
        const fileLink = await ctx.telegram.getFileLink(targetFileId);
        const networkResponse = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        let mediaBuffer = Buffer.from(networkResponse.data);

        // Convert WebP/Unsupported formats to standard JPEG via Sharp
        if (needsFormatConversion) {
            mediaBuffer = await sharp(mediaBuffer).jpeg().toBuffer();
        }

        // 4. Tensor Processing & Classification
        const imageTensor = tf.node.decodeImage(mediaBuffer, 3);
        const inferenceResults = await nsfwModel.classify(imageTensor);
        
        // Crucial: Prevent memory leaks in serverless architecture
        imageTensor.dispose(); 
        
        // 5. Zero-Tolerance Validation
        let isViolation = false;
        for (const attribute of inferenceResults) {
            // Strict Threshold: 0.40 (40% confidence triggers execution)
            if (['Porn', 'Hentai', 'Sexy'].includes(attribute.className) && attribute.probability > 0.40) {
                isViolation = true;
                break;
            }
        }

        // 6. Execution & Penalties
        if (isViolation) {
            // Immediate silent purge
            await ctx.deleteMessage(payload.message_id).catch(() => {});

            const violatorId = ctx.from.id;
            const contextChatId = ctx.chat.id;

            // Increment strike counter
            let violatorProfile = spamTracker.get(violatorId) || { strikes: 0 };
            violatorProfile.strikes += 1;
            spamTracker.set(violatorId, violatorProfile);

            // Penalty enforcement: 5 strikes = 10 Minute Mute
            if (violatorProfile.strikes >= 5) {
                const isolationDuration = 10; // Minutes
                const releaseTimestamp = Math.floor(Date.now() / 1000) + (isolationDuration * 60);

                // Execute mute protocol
                await ctx.telegram.restrictChatMember(contextChatId, violatorId, {
                    permissions: { can_send_messages: false },
                    until_date: releaseTimestamp
                }).catch(() => {}); 

                // Professional English Mute Notification
                const enforcementLog = await ctx.reply(
                    "⚠️ **Access Restricted**\n" +
                    "A user has been temporarily silenced for 10 minutes due to consecutive zero-tolerance media violations. System integrity maintained.",
                    { parse_mode: "Markdown" }
                );

                // Auto-delete the notification after 8 seconds to maintain chat aesthetic
                setTimeout(() => ctx.deleteMessage(enforcementLog.message_id).catch(() => {}), 8000);

                // Reset strikes post-penalty
                spamTracker.delete(violatorId);
            }
        }
    } catch (criticalError) {
        console.error("System Exception:", criticalError.message);
    }
});

// --- Serverless Entry Point ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            // Implement timeout race-condition to satisfy Vercel limits
            await Promise.race([
                bot.handleUpdate(req.body, res),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Function Timeout Pre-empted')), 8500))
            ]).catch(err => console.log('Controlled Exit:', err.message));
            
            res.status(200).send('OK');
        } else {
            res.status(200).send('Aegis Moderation Engine Operational.');
        }
    } catch (serverError) {
        res.status(500).send('Internal Architecture Error');
    }
};
        
