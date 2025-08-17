import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  SlashCommandBuilder,
  Collection
} from "discord.js";
import dotenv from "dotenv";
dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.commands = new Collection();

// only BOT_TOKEN is needed in .env
// guild config stored in memory
const guildConfigs = new Map(); // guildId -> config

// ───────────────────────────────
// Slash Commands
// ───────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("support_setup")
    .setDescription("Setup ticket system for this guild")
    .addChannelOption(opt =>
      opt.setName("general_support_channel").setDescription("Channel for general support requests").setRequired(true))
    .addChannelOption(opt =>
      opt.setName("community_support_channel").setDescription("Channel for community support requests").setRequired(true))
    .addChannelOption(opt =>
      opt.setName("ticket_category").setDescription("Category where tickets will be created").setRequired(true))
    .addRoleOption(opt =>
      opt.setName("loa_role").setDescription("Role that cannot claim tickets").setRequired(true))
    .addRoleOption(opt =>
      opt.setName("general_support_role").setDescription("Role that can handle General Support tickets").setRequired(true))
    .addRoleOption(opt =>
      opt.setName("community_support_role").setDescription("Role that can handle Community Support tickets").setRequired(true)),

  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Ticket commands")
    .addSubcommand(sub =>
      sub.setName("create")
        .setDescription("Create a support ticket")
        .addStringOption(opt =>
          opt.setName("type").setDescription("Ticket type")
            .addChoices(
              { name: "General Support", value: "general" },
              { name: "Community Support", value: "community" }
            )
            .setRequired(true)))
    .addSubcommand(sub => sub.setName("claim").setDescription("Claim this ticket"))
    .addSubcommand(sub =>
      sub.setName("add_user")
        .setDescription("Add user to this ticket")
        .addUserOption(opt => opt.setName("user").setDescription("User to add").setRequired(true)))
    .addSubcommand(sub =>
      sub.setName("remove_user")
        .setDescription("Remove user from this ticket")
        .addUserOption(opt => opt.setName("user").setDescription("User to remove").setRequired(true)))
];

// ───────────────────────────────
// Interaction Handler
// ───────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu()) return;

  // ──────────────── support_setup
  if (interaction.isChatInputCommand() && interaction.commandName === "support_setup") {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: "❌ Only admins can run this.", ephemeral: true });
    }

    const config = {
      generalSupportChannel: interaction.options.getChannel("general_support_channel").id,
      communitySupportChannel: interaction.options.getChannel("community_support_channel").id,
      ticketCategory: interaction.options.getChannel("ticket_category").id,
      loaRole: interaction.options.getRole("loa_role").id,
      generalSupportRole: interaction.options.getRole("general_support_role").id,
      communitySupportRole: interaction.options.getRole("community_support_role").id
    };

    guildConfigs.set(interaction.guild.id, config);

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle("✅ Support System Configured")
        .setDescription("The ticket system is now set up for this server.")
        .addFields(
          { name: "General Support Requests", value: `<#${config.generalSupportChannel}>` },
          { name: "Community Support Requests", value: `<#${config.communitySupportChannel}>` },
          { name: "Ticket Category", value: `<#${config.ticketCategory}>` },
          { name: "LOA Role", value: `<@&${config.loaRole}>` },
          { name: "General Support Role", value: `<@&${config.generalSupportRole}>` },
          { name: "Community Support Role", value: `<@&${config.communitySupportRole}>` }
        )
        .setColor("Green")]
    });
  }

  // ──────────────── ticket
  if (interaction.isChatInputCommand() && interaction.commandName === "ticket") {
    const config = guildConfigs.get(interaction.guild.id);
    if (!config) return interaction.reply({ content: "❌ Run `/support_setup` first.", ephemeral: true });

    const sub = interaction.options.getSubcommand();

    if (sub === "create") {
      const type = interaction.options.getString("type");
      const supportRole = type === "general" ? config.generalSupportRole : config.communitySupportRole;
      const staffChannelId = type === "general" ? config.generalSupportChannel : config.communitySupportChannel;

      const ticketChannel = await interaction.guild.channels.create({
        name: `ticket-${interaction.user.username}`,
        type: 0,
        parent: config.ticketCategory,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: supportRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
        ]
      });

      const staffChannel = await interaction.guild.channels.fetch(staffChannelId);
      await staffChannel.send({
        embeds: [new EmbedBuilder()
          .setTitle(`${type === "general" ? "General" : "Community"} Support Ticket`)
          .setDescription(`Ticket created by ${interaction.user} → ${ticketChannel}`)
          .setColor("Blue")]
      });

      return interaction.reply({ content: `✅ Ticket created: ${ticketChannel}`, ephemeral: true });
    }

    if (sub === "claim") {
      if (!interaction.channel.name.startsWith("ticket-")) {
        return interaction.reply({ content: "❌ Use this in a ticket channel.", ephemeral: true });
      }
      if (interaction.member.roles.cache.has(config.loaRole)) {
        return interaction.reply({ content: "❌ LOA role cannot claim tickets.", ephemeral: true });
      }
      if (interaction.channel.topic && interaction.channel.topic.includes("CLAIMED")) {
        return interaction.reply({ content: "❌ Already claimed.", ephemeral: true });
      }

      await interaction.channel.setTopic(`CLAIMED by ${interaction.user.tag}`);
      return interaction.reply({ content: `✅ Ticket claimed by ${interaction.user}` });
    }

    if (sub === "add_user") {
      const user = interaction.options.getUser("user");
      await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true });
      return interaction.reply({ content: `✅ Added ${user} to this ticket.` });
    }

    if (sub === "remove_user") {
      const user = interaction.options.getUser("user");
      await interaction.channel.permissionOverwrites.delete(user.id);
      return interaction.reply({ content: `✅ Removed ${user} from this ticket.` });
    }
  }
});

client.once("ready", () => console.log(`${client.user.tag} is online!`));
client.login(process.env.BOT_TOKEN);
