const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const fs = require('fs');

// Load configuration from config.json
const config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
const TOKEN = config.token;
const WEBHOOK_URL = config.webhook;
const SOURCE_SERVER = config.source_channels;
const TARGET_THREAD_ID = config.thread_id;
const DESTINATION_ROLE_ID = config.destination_role_id;
const POST_LAST_MESSAGE_ON_STARTUP = config.post_last_message_on_startup;
const USE_THREAD = config.use_thread;
const MONITOR_MODE = config.monitor_mode;
const KEYWORDS = config.keywords;
const ALERT_ROLE_ID = config.alert_role_id;

const client = new Client();

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.username}`);

    if (POST_LAST_MESSAGE_ON_STARTUP === 1) {
        try {
            for (const channelId of SOURCE_SERVER) {
                const channel = await client.channels.fetch(channelId);
                if (!channel || !channel.isText()) {
                    console.log(`Invalid or inaccessible channel: ${channelId}`);
                    continue;
                }

                const messages = await channel.messages.fetch({ limit: 1 });
                const lastMessage = messages.first();

                if (lastMessage) {
                    await forwardMessage(lastMessage);
                    console.log(`Last message from channel ${channelId} forwarded.`);
                } else {
                    console.log(`No messages found in channel ${channelId}.`);
                }
            }
        } catch (error) {
            console.error(`Error fetching or forwarding messages: ${error}`);
        }
    }
});

// Helper function to split message content into chunks
function splitMessage(content, maxLength = 2000) {
    if (content.length <= maxLength) {
        return [content];
    }

    const splitText = [];
    let currentIndex = 0;

    while (currentIndex < content.length) {
        let splitIndex = currentIndex + maxLength;

        if (splitIndex < content.length) {
            let lastSpaceIndex = content.lastIndexOf('\n', splitIndex);
            if (lastSpaceIndex === -1 || lastSpaceIndex < currentIndex) {
                lastSpaceIndex = content.lastIndexOf(' ', splitIndex);
            }
            if (lastSpaceIndex === -1 || lastSpaceIndex < currentIndex) {
                lastSpaceIndex = splitIndex;
            }
            splitIndex = lastSpaceIndex;
        }

        splitText.push(content.substring(currentIndex, splitIndex).trim());
        currentIndex = splitIndex;
    }

    return splitText;
}

// Sleeper
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to forward a message to the webhook
async function forwardMessage(message, isEdit = false) {
    try {
        let content = message.content ? message.content : '';

        // Replace any role mention with the destination role mention (only for new messages)
        if (!isEdit) {
            const roleMentionRegex = /<@&\d+>/g;
            content = content.replace(roleMentionRegex, `<@&${DESTINATION_ROLE_ID}>`);
        }

        // Check for keywords if enabled
        let alertTriggered = false;
        if (MONITOR_MODE === 1 && message.content) {
            alertTriggered = KEYWORDS.some(keyword => {
                const wordBoundaryRegex = new RegExp(`\\b${keyword}\\b`, 'i');
                return wordBoundaryRegex.test(message.content);
            });
            if (alertTriggered) {
                content = `<@&${ALERT_ROLE_ID}> ` + content;
            }
        }

        // Include embed details if available
        if (message.embeds.length > 0) {
            message.embeds.forEach((embed, index) => {
                content += `\n**Embed ${index + 1} Title:** ${embed.title || ''}\n`;
                content += `**Embed Description:** ${embed.description || ''}\n`;
                content += `**Fields:**\n`;

                embed.fields.forEach(field => {
                    content += `**${field.name}:** ${field.value}\n`;
                });
            });
        }

        // Check for attachments (images)
        const attachments = Array.from(message.attachments.values());
        const imageUrls = attachments.map(attachment => attachment.url);

        // Indicate if the message is an edit
        if (isEdit) {
            content = `**[Edited]** ${content}`;
        }

        // Decide what to post to the webhook, avoiding dupes and 400s
        let allowed_mentions;
        if (!isEdit) {
            let rolesAllowed = [DESTINATION_ROLE_ID];
            if (alertTriggered && !rolesAllowed.includes(ALERT_ROLE_ID)) {
                rolesAllowed.push(ALERT_ROLE_ID);
            }
            allowed_mentions = {
                parse: [],
                roles: rolesAllowed,
                users: []
            };
        } else {
            allowed_mentions = {
                parse: [],
                roles: alertTriggered ? [ALERT_ROLE_ID] : []
            };
        }

        // Split the message into chunks
        const chunks = splitMessage(content, 2000);

        for (const chunk of chunks) {
            // Use the thread if enabled
            const webhookURL = USE_THREAD === 1 
                ? `${WEBHOOK_URL}?thread_id=${TARGET_THREAD_ID}` 
                : WEBHOOK_URL;

            const data = {
                content: chunk,
                username: message.author.username,
                avatar_url: message.author.displayAvatarURL({ format: 'png', dynamic: true }),
                allowed_mentions: allowed_mentions,  // Use the new allowed_mentions
                embeds: imageUrls.map(url => ({
                    image: { url } // Attach images as embeds
                }))
            };

            // Rate limit handling
            let posted = false;
            while (!posted) {
                try {
                    await axios.post(webhookURL, data);
                    posted = true;
                } catch (error) {
                    if (error.response && error.response.status === 429) {
                        // Discord rate limit encountered. Respect the "retry_after" delay provided.
                        const retryAfter = error.response.data?.retry_after || 1000;
                        console.warn(`Rate limited: waiting ${retryAfter}ms before retrying.`);
                        await sleep(retryAfter);
                    } else {
                        console.error(`Failed to forward message from channel ${message.channel.id}. Error: ${error}`);
                        posted = true;
                    }
                }
            }
        }
    } catch (error) {
        console.error(`Failed to forward message from channel ${message.channel.id}. Error: ${error}`);
    }
}

// Event listener for new messages
client.on('messageCreate', async (message) => {
    if (message.author.id === client.user.id) return;

    // Check if the message is in one of the monitored channels
    if (SOURCE_SERVER.includes(message.channel.id)) {
        await forwardMessage(message);
        console.log(`New message from channel ${message.channel.id} forwarded.`);
    }
});

// Event listener for message edits
client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (newMessage.author.id === client.user.id) return;

    if (!oldMessage.partial && newMessage.content === oldMessage.content) {
        return;
    }

    if (!newMessage.editedTimestamp || newMessage.editedTimestamp === newMessage.createdTimestamp) {
        return;
    }

    // Check if the edited message is in one of the monitored channels
    if (SOURCE_SERVER.includes(newMessage.channel.id)) {
        await forwardMessage(newMessage, true);
        console.log(`Edited message from channel ${newMessage.channel.id} forwarded.`);
    }
});

// Log in with the self-bot token
client.login(TOKEN);
