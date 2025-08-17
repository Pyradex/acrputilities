// ACRP Utilities Bot
// Single-file structure as requested

const { Client, GatewayIntentBits, Partials, ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, PermissionsBitField, Collection } = require("discord.js");
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ====== CONFIG ======
const PREFIX = "!";
const YOUR_TICKET_CATEGORY = process.env.TICKET_CATEGORY_ID; // Category ID for tickets
const LOG_CHANNEL = process.env.LOG_CHANNEL_ID; // Ticket log channel
const APPROVAL_CHANNEL = process.env.APPROVAL_CHANNEL_ID; // CCR/SCR approval channel
const SESSION_CHANNEL = process.env.SESSION_CHANNEL_ID; // Sessions
const CCR_ROLE = process.env.CCR_ROLE_ID;
const SCR_ROLE = process.env.SCR_ROLE_ID;

// ====== COMMAND HANDLER ======
client.commands = new Collection();

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ====== TICKET SYSTEM ======
client.on("interactionCreate", async (interaction) => {
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "ticket_select") {
      const team = interaction.values[0];
      const ticketChannel = await interaction.guild.channels.create({
        name: `ticket-${interaction.user.username}`,
        type: 0,
        parent: YOUR_TICKET_CATEGORY,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        ],
      });

      await ticketChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("🎫 New Support Ticket")
            .setDescription(`Ticket opened by <@${interaction.user.id}> for **${team}** team.`)
            .setColor("Blue")
        ]
      });

      await interaction.reply({ content: `Ticket created: ${ticketChannel}`, ephemeral: true });

      // Log
      const logEmbed = new EmbedBuilder()
        .setTitle("📑 Ticket Log")
        .setDescription(`Ticket by: <@${interaction.user.id}>\nTeam: ${team}\nChannel: ${ticketChannel}`)
        .setColor("Purple");
      client.channels.cache.get(LOG_CHANNEL)?.send({ embeds: [logEmbed] });
    }

    if (interaction.customId === "approval_menu") {
      if (interaction.values[0] === "approve") {
        await interaction.update({ content: "✅ Approved broadcast", components: [] });
      } else {
        await interaction.update({ content: "❌ Declined broadcast", components: [] });
      }
    }
  }
});

// ====== TEAM REQUEST COMMAND ======
client.on("messageCreate", async (msg) => {
  if (!msg.content.startsWith(PREFIX) || msg.author.bot) return;
  const [cmd, ...args] = msg.content.slice(PREFIX.length).split(" ");

  if (cmd === "requestmsg") {
    const heading = args[0];
    const message = args.slice(1).join(" ");

    const embed = new EmbedBuilder()
      .setTitle("📢 Message Request")
      .setDescription(`**Heading:** ${heading}\n**Message:** ${message}\n**From:** ${msg.author.tag}`)
      .setColor("Blue")
      .setFooter({ text: `Regards,\nThe ${heading} Team` });

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("approval_menu")
        .setPlaceholder("Choose an action")
        .addOptions([
          { label: "Approve The Message Broadcast", value: "approve" },
          { label: "Decline The Message Broadcast", value: "decline" }
        ])
    );

    client.channels.cache.get(APPROVAL_CHANNEL)?.send({ embeds: [embed], components: [row] });
    await msg.reply("✅ Request submitted for approval.");
  }

  // ====== MODERATION COMMANDS ======
  if (cmd === "ban") {
    const member = msg.mentions.members.first();
    if (!member) return msg.reply("❌ Mention a user.");
    await member.ban();
    await member.send(`🚫 You have been banned from **${msg.guild.name}**.`);
    msg.channel.send({ embeds: [new EmbedBuilder().setTitle("🔨 Ban").setDescription(`${member.user.tag} banned by ${msg.author.tag}`).setColor("Red")] });
  }

  if (cmd === "kick") {
    const member = msg.mentions.members.first();
    if (!member) return msg.reply("❌ Mention a user.");
    await member.kick();
    await member.send(`⚠️ You have been kicked from **${msg.guild.name}**.`);
    msg.channel.send({ embeds: [new EmbedBuilder().setTitle("👢 Kick").setDescription(`${member.user.tag} kicked by ${msg.author.tag}`).setColor("Orange")] });
  }

  // ====== SESSION COMMANDS ======
  if (cmd === "session") {
    const type = args[0]; // start, shutdown, low, full
    let embed;
    switch (type) {
      case "start":
        embed = new EmbedBuilder().setTitle("🟢 Session Started").setColor("Green");
        break;
      case "shutdown":
        embed = new EmbedBuilder().setTitle("🔴 Session Shutdown").setColor("Red");
        break;
      case "low":
        embed = new EmbedBuilder().setTitle("🟡 Session Low").setColor("Yellow");
        break;
      case "full":
        embed = new EmbedBuilder().setTitle("🔵 Session Full").setColor("Blue");
        break;
      default:
        return msg.reply("❌ Usage: !session <start|shutdown|low|full>");
    }
    client.channels.cache.get(SESSION_CHANNEL)?.send({ embeds: [embed] });
    msg.reply("✅ Session status updated.");
  }
});

client.login(process.env.BOT_TOKEN);
