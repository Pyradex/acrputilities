const { Client, GatewayIntentBits, Partials, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionsBitField } = require('discord.js');
const fs = require('fs');

// --- CONFIGURATION ---
// Use Render.com environment variables directly
const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const ASSISTANCE_CHANNEL_ID = process.env.ASSISTANCE_CHANNEL_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const HR_CHANNEL_ID = process.env.HR_CHANNEL_ID;
const ANNOUNCEMENT_CHANNELS = process.env.ANNOUNCEMENT_CHANNELS?.split(','); // comma-separated IDs
const MODERATOR_ROLE_ID = process.env.MODERATOR_ROLE_ID;
const HR_ROLE_ID = process.env.HR_ROLE_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

// --- LOAD / SAVE DATA ---
let data = { suggestions: [], requests: [] };
const DATA_FILE = './data.json';
if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

// --- UTILITY FUNCTIONS ---
function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// --- BOT READY ---
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    const guild = await client.guilds.fetch(GUILD_ID);

    // Setup dropdown in Assistance channel
    const channel = await guild.channels.fetch(ASSISTANCE_CHANNEL_ID);
    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('ticket_dropdown')
                .setPlaceholder('Open a ticket...')
                .addOptions([
                    { label: 'Support', value: 'support' },
                    { label: 'Suggestion', value: 'suggestion' }
                ])
        );
    await channel.send({ content: 'Select a ticket type:', components: [row] });
});

// --- INTERACTIONS ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isStringSelectMenu() && !interaction.isButton()) return;

    // --- TICKET DROPDOWN ---
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_dropdown') {
        const type = interaction.values[0];
        const guild = interaction.guild;

        // Create ticket channel
        const ticketChannel = await guild.channels.create({
            name: `${type}-${interaction.user.username}`,
            type: 0, // GUILD_TEXT
            parent: TICKET_CATEGORY_ID,
            permissionOverwrites: [
                { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel] },
                { id: HR_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel] }
            ]
        });

        if (type === 'support') {
            ticketChannel.send(`Hello ${interaction.user}, an HR member will assist you soon.`);
        } else if (type === 'suggestion') {
            ticketChannel.send(`Thanks for your suggestion! HR will review it shortly.`);
        }

        data.suggestions.push({ user: interaction.user.id, type, channel: ticketChannel.id });
        saveData();
        await interaction.reply({ content: `Ticket created: ${ticketChannel}`, ephemeral: true });
    }

    // --- HR BUTTON ---
    if (interaction.isButton() && interaction.customId.startsWith('approve_')) {
        const [_, requestId] = interaction.customId.split('_');
        const request = data.requests.find(r => r.id === requestId);
        if (!request) return interaction.reply({ content: 'Request not found.', ephemeral: true });

        request.approved = true;
        saveData();
        await interaction.reply({ content: `Request approved by HR!`, ephemeral: true });

        // Send message in announcement channels
        for (const chId of ANNOUNCEMENT_CHANNELS) {
            const ch = await interaction.guild.channels.fetch(chId);
            ch.send(`HR-approved message from ${request.user}: ${request.message}`);
        }
    }
});

// --- MODERATOR REQUESTS ---
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.member.roles.cache.has(MODERATOR_ROLE_ID)) return;

    // Example: moderator sends !request <message>
    if (message.content.startsWith('!request ')) {
        const content = message.content.replace('!request ', '');
        const id = Date.now().toString();
        data.requests.push({ id, user: message.author.id, message: content, approved: false });
        saveData();

        const hrChannel = await client.channels.fetch(HR_CHANNEL_ID);
        const embed = new EmbedBuilder()
            .setTitle('New Moderator Request')
            .setDescription(content)
            .setFooter({ text: `Request ID: ${id}` });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`approve_${id}`)
                    .setLabel('Approve')
                    .setStyle(ButtonStyle.Success)
            );
        hrChannel.send({ embeds: [embed], components: [row] });
        message.reply('Request sent to HR for approval.');
    }
});

client.login(TOKEN);
