const { Client, GatewayIntentBits, Partials, Collection, ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const commands = require('./commands.js');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
});

client.commands = new Collection();

// Register commands
for (const cmd of Object.values(commands)) {
    client.commands.set(cmd.name, cmd);
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

// Interaction handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() && !interaction.isStringSelectMenu()) return;

    // Slash command handling
    if (interaction.isCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;
        try { await command.execute(interaction, client); } 
        catch (err) { console.error(err); }
    }

    // Dropdown handling
    if (interaction.isStringSelectMenu()) {
        const customId = interaction.customId;
        if (customId.startsWith('ticket-claim')) {
            commands.ticketDropdown(interaction, client);
        }
        if (customId.startsWith('broadcast-approval')) {
            commands.broadcastDropdown(interaction, client);
        }
    }
});

client.login(process.env.TOKEN);
