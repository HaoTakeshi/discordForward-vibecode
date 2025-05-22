const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
const {
    token: TOKEN,
    webhook_url: WEBHOOK_URL,
    source_channels: SOURCE_SERVER,
    thread_id: TARGET_THREAD_ID,
    destination_role_id: DESTINATION_ROLE_ID,
    post_last_message_on_startup: POST_LAST_MESSAGE_ON_STARTUP,
    use_thread: USE_THREAD,
    monitor_mode: MONITOR_MODE,
    keywords: KEYWORDS,
    ping_role_id: PING_ROLE_ID
} = config;

const client = new Client();

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.username}`);
    if (POST_LAST_MESSAGE_ON_STARTUP === 1) {
        for (const channelId of SOURCE_SERVER) {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.isText()) continue;
            const messages = await channel.messages.fetch({ limit: 1 });
            const lastMessage = messages.first();
            if (lastMessage) await forwardMessage(lastMessage);
        }
    }
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function forwardMessage(message, isEdit = false) {
    try {
        let content = message.content || '';
        content = content.replace(/@everyone/g, '');

        if (PING_ROLE_ID) {
            content = `<@&${PING_ROLE_ID}> ${content}`;
        }

        if (!isEdit && DESTINATION_ROLE_ID) {
            const roleMentionRegex = /<@&\d+>/g;
            content = content.replace(roleMentionRegex, `<@&${DESTINATION_ROLE_ID}>`);
        }

        const rolesAllowed = [];
        if (PING_ROLE_ID) rolesAllowed.push(PING_ROLE_ID);
        if (!isEdit && DESTINATION_ROLE_ID && !rolesAllowed.includes(DESTINATION_ROLE_ID)) {
            rolesAllowed.push(DESTINATION_ROLE_ID);
        }

        const allowed_mentions = {
            parse: [],
            roles: rolesAllowed,
            users: []
        };

        const attachments = Array.from(message.attachments.values());
        const imageUrls = attachments.map(att => att.url);

        const embeds = [...message.embeds.map(e => e.toJSON()), ...imageUrls.map(url => ({ image: { url } }))];

        const webhookURL = USE_THREAD === 1 ? `${WEBHOOK_URL}?thread_id=${TARGET_THREAD_ID}` : WEBHOOK_URL;

        const data = {
            content,
            username: message.author.username,
            avatar_url: message.author.displayAvatarURL({ format: 'png', dynamic: true }),
            allowed_mentions
        };

        if (embeds.length > 0) {
            data.embeds = embeds;
        }

        let posted = false;
        while (!posted) {
            try {
                await axios.post(webhookURL, data);
                posted = true;
            } catch (err) {
                if (err.response?.status === 429) {
                    const wait = err.response.data?.retry_after || 1000;
                    await sleep(wait);
                } else {
                    console.error(`Error sending message: ${err}`);
                    posted = true;
                }
            }
        }
    } catch (err) {
        console.error(`Error forwarding message: ${err}`);
    }
}

client.on('messageCreate', async (message) => {
    if (message.author.id === client.user.id) return;
    if (SOURCE_SERVER.includes(message.channel.id)) {
        await forwardMessage(message);
    }
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
    if (newMsg.author.id === client.user.id) return;
    if (!oldMsg.partial && newMsg.content === oldMsg.content) return;
    if (!newMsg.editedTimestamp || newMsg.editedTimestamp === newMsg.createdTimestamp) return;
    if (SOURCE_SERVER.includes(newMsg.channel.id)) {
        await forwardMessage(newMsg, true);
    }
});

client.login(TOKEN);
