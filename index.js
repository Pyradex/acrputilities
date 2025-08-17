import 'dotenv/config';
import fs from 'fs-extra';
import express from 'express';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { handleCommands } from './commands.js';

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// Ready
client.once('ready', () => {
  console.log(`${client.user.tag} is online!`);
});

// Handle commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu()) return;
  handleCommands(client, interaction);
});

// Express ping for Render.com / UptimeRobot
app.get('/', (req, res) => res.send('ACRP Utilities Bot is running!'));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

// Login
client.login(process.env.DISCORD_TOKEN);
