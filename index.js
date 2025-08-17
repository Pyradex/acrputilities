/**
 * ACRP Utilities — single-file bot (slash-commands only)
 * Spec coverage:
 * - Ticket system with assistance dropdown (no embed text), tickets under category ID, claim via dropdown (no buttons), clean log embeds + transcript
 * - Team Message Request & Approval workflow with approve/decline dropdown
 * - Moderation slash commands (embeds + DM)
 * - Session system (vote/start/shutdown/low/full) posting to SESSION_CHANNEL_ID
 * - Minimal deploy: Mac → GitHub → Render → UptimeRobot. No .env used—Render env vars only.
 *
 * Required Environment Vars (Render):
 *  BOT_TOKEN
 *  TICKET_CATEGORY_ID
 *  LOG_CHANNEL_ID
 *  APPROVAL_CHANNEL_ID
 *  SESSION_CHANNEL_ID
 *  CCR_ROLE_ID
 *  SCR_ROLE_ID
 *
 * Optional (recommended in practice, but NOT required):
 *  NONE – teams resolved by name matching in the server
 *
 * NOTE: In Discord Developer Portal, enable **Message Content Intent** and **Server Members Intent**.
 */

const { Client, GatewayIntentBits, Partials, ChannelType, PermissionFlagsBits,
        ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, AttachmentBuilder,
        REST, Routes } = require('discord.js');
const express = require('express');

// ───────────────────────────────────────────────────────────────────────────────
// Basic web server for Render/UptimeRobot keep-alive (free-tier friendly)
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
app.get('/', (_req, res) => res.status(200).send('ACRP Utilities is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[web] Listening on :${PORT}`));

// ───────────────────────────────────────────────────────────────────────────────
// Environment
// ───────────────────────────────────────────────────────────────────────────────
const {
  BOT_TOKEN,
  TICKET_CATEGORY_ID,
  LOG_CHANNEL_ID,
  APPROVAL_CHANNEL_ID,
  SESSION_CHANNEL_ID,
  CCR_ROLE_ID,
  SCR_ROLE_ID,
} = process.env;

// sanity checks
[
  'BOT_TOKEN','TICKET_CATEGORY_ID','LOG_CHANNEL_ID','APPROVAL_CHANNEL_ID','SESSION_CHANNEL_ID','CCR_ROLE_ID','SCR_ROLE_ID'
].forEach((k) => {
  if (!process.env[k]) console.warn(`[warn] Missing env var ${k}. Make sure to set it on Render!`);
});

// ───────────────────────────────────────────────────────────────────────────────
// Discord client
// ───────────────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // enable in Developer Portal
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
});

// ───────────────────────────────────────────────────────────────────────────────
// Constants & Utilities
// ───────────────────────────────────────────────────────────────────────────────
const TEAM_ROLE_NAMES = [
  'Game Team', 'Chain Team', 'Support Team', 'QA Team', 'Media Team', 'Event Team',
];
const CATEGORY_OPTIONS = [
  { label: 'General Support', value: 'general-support', roleName: 'General Support' },
  { label: 'Staff Report', value: 'staff-report', roleName: 'Staff Report' },
  { label: 'Management Support', value: 'management-support', roleName: 'Management Support' },
];

// In-memory state (non-persistent by design, simple & minimal)
const approvalRequests = new Map(); // approvalMessageId -> { targetChannelId, payloadEmbedData, footerText }
const sessionVotes = new Map();     // messageId -> { votes: Map(userId -> value), counts: {yes,no,abstain} }
const openTickets = new Map();      // ticketChannelId -> { openerId, categoryValue, categoryLabel, optionClickedBy, createdAt, claimedBy }

// helper: duration parsing like "15m", "2h", "1d"
function parseDuration(str) {
  const m = /^(\d+)\s*([smhd])$/i.exec(String(str).trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * multipliers[unit];
}
function shortId() {
  return Math.random().toString(36).slice(2, 7);
}
function fmtTime(ts = Date.now()) {
  return `<t:${Math.floor(ts / 1000)}:F>`; // Discord timestamp
}
function hasAnyRole(member, roleIdsOrNames = []) {
  const roles = member.roles.cache;
  return roleIdsOrNames.some((r) =>
    /^\d+$/.test(r) ? roles.has(r) : roles.some(role => role.name === r)
  );
}
function isStaff(member) {
  return hasAnyRole(member, [CCR_ROLE_ID, SCR_ROLE_ID, ...TEAM_ROLE_NAMES]);
}

// build a plain-text transcript (compact, stable, no extra deps)
async function buildTranscript(channel) {
  let lastId;
  const lines = [];
  while (true) {
    const fetched = await channel.messages.fetch({ limit: 100, before: lastId });
    if (fetched.size === 0) break;
    fetched.sort((a,b)=>a.createdTimestamp - b.createdTimestamp).forEach(msg => {
      const time = new Date(msg.createdTimestamp).toISOString();
      const author = `${msg.author.tag} (${msg.author.id})`;
      const content = msg.content || '';
      const atts = msg.attachments?.size ? ` [attachments: ${[...msg.attachments.values()].map(a=>a.url).join(', ')}]` : '';
      lines.push(`[${time}] ${author}: ${content}${atts}`);
    });
    lastId = fetched.first().id;
  }
  return lines.join('\n');
}

// pick a team role by category value
function findTeamRoleByCategory(guild, categoryValue) {
  const info = CATEGORY_OPTIONS.find(o => o.value === categoryValue);
  if (!info) return null;
  return guild.roles.cache.find(r => r.name === info.roleName) || null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Slash Command Registration (global)
// ───────────────────────────────────────────────────────────────────────────────
async function registerSlashCommands() {
  const commands = [
    // Bot setup: configure all channels and roles
    {
      name: 'setup-bot',
      description: 'Configure all bot features including channels and roles.',
      options: [
        {
          name: 'ticket_category',
          description: 'Category where tickets will be created.',
          type: 7, // CHANNEL
          required: true,
        },
        {
          name: 'log_channel',
          description: 'Channel for moderation and ticket logs.',
          type: 7, // CHANNEL
          required: true,
        },
        {
          name: 'approval_channel',
          description: 'Channel for message approval requests.',
          type: 7, // CHANNEL
          required: true,
        },
        {
          name: 'session_channel',
          description: 'Channel for session announcements.',
          type: 7, // CHANNEL
          required: true,
        },
        {
          name: 'staff_role',
          description: 'Role for staff members.',
          type: 8, // ROLE
          required: true,
        },
        {
          name: 'admin_role',
          description: 'Role for administrators.',
          type: 8, // ROLE
          required: true,
        },
        {
          name: 'under_investigation_role',
          description: 'Role for members under investigation.',
          type: 8, // ROLE
          required: true,
        }
      ]
    },

    // Staff investigation
    {
      name: 'staff-investigation',
      description: 'Place a staff member under investigation.',
      options: [
        {
          name: 'member',
          description: 'Staff member to investigate.',
          type: 6, // USER
          required: true,
        },
        {
          name: 'reason',
          description: 'Reason for investigation.',
          type: 3, // STRING
          required: true,
        }
      ]
    },

    // Rank change
    {
      name: 'rank-change',
      description: 'Change a member\'s role/rank.',
      options: [
        {
          name: 'member',
          description: 'Member to change rank.',
          type: 6, // USER
          required: true,
        },
        {
          name: 'new_role',
          description: 'New role to assign.',
          type: 8, // ROLE
          required: true,
        },
        {
          name: 'reason',
          description: 'Reason for rank change.',
          type: 3, // STRING
          required: true,
        }
      ]
    },

    // Shift management
    {
      name: 'shift-start',
      description: 'Start your staff shift.',
    },
    {
      name: 'shift-end',
      description: 'End your staff shift.',
    },
    {
      name: 'shift-status',
      description: 'Check current staff on shift.',
    },

    // Ticket setup: drops the assistance dropdown (no embed) into a given channel
    {
      name: 'setup-assistance',
      description: 'Post the Assistance dropdown (no embed text) to a channel.',
      options: [
        {
          name: 'channel',
          description: 'Channel to post the assistance dropdown.',
          type: 7, // CHANNEL
          required: true,
        }
      ]
    },

    // Message Request & Approval
    {
      name: 'requestmsg',
      description: 'Request a broadcast message for approval.',
      options: [
        { name: 'heading', description: 'Heading/title', type: 3, required: true }, // STRING
        { name: 'message', description: 'Message body', type: 3, required: true }, // STRING
        { name: 'team',    description: 'Your team role', type: 8, required: true }, // ROLE
      ]
    },

    // Moderation
    {
      name: 'ban',
      description: 'Ban a user (DM + embed log).',
      options: [
        { name: 'user', type: 6, description: 'User to ban', required: true }, // USER
        { name: 'reason', type: 3, description: 'Reason', required: true },
      ]
    },
    {
      name: 'kick',
      description: 'Kick a user (DM + embed log).',
      options: [
        { name: 'user', type: 6, description: 'User to kick', required: true },
        { name: 'reason', type: 3, description: 'Reason', required: true },
      ]
    },
    {
      name: 'warn',
      description: 'Warn a user (DM + embed log).',
      options: [
        { name: 'user', type: 6, description: 'User to warn', required: true },
        { name: 'reason', type: 3, description: 'Reason', required: true },
      ]
    },
    {
      name: 'timeout',
      description: 'Timeout a user for a duration (e.g., 10m, 2h).',
      options: [
        { name: 'user', type: 6, description: 'User to timeout', required: true },
        { name: 'time', type: 3, description: 'Duration like 10m, 2h, 1d', required: true },
        { name: 'reason', type: 3, description: 'Reason', required: true },
      ]
    },
    {
      name: 'untimeout',
      description: 'Remove timeout from a user.',
      options: [
        { name: 'user', type: 6, description: 'User to untimeout', required: true },
      ]
    },
    {
      name: 'mute',
      description: 'Alias of timeout (same behavior): mute a user for a duration.',
      options: [
        { name: 'user', type: 6, description: 'User to mute', required: true },
        { name: 'time', type: 3, description: 'Duration like 10m, 2h, 1d', required: true },
        { name: 'reason', type: 3, description: 'Reason', required: true },
      ]
    },
    {
      name: 'unmute',
      description: 'Alias of untimeout (remove timeout).',
      options: [
        { name: 'user', type: 6, description: 'User to unmute', required: true },
      ]
    },

    // Session system
    {
      name: 'session',
      description: 'Session system controls',
      options: [
        {
          name: 'vote',
          description: 'Start a session vote',
          type: 1, // SUBCOMMAND
          options: [{ name: 'question', type: 3, description: 'Vote question', required: true }]
        },
        { name: 'start',    description: 'Announce session start',    type: 1 },
        { name: 'shutdown', description: 'Announce session shutdown', type: 1 },
        { name: 'low',      description: 'Announce session low',      type: 1 },
        { name: 'full',     description: 'Announce session full',     type: 1 },
      ]
    },
  ];

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const appId = client.application.id;
  
  // Force refresh by clearing existing commands first
  try {
    await rest.put(Routes.applicationCommands(appId), { body: [] });
    console.log('[slash] Cleared existing commands');
  } catch (e) {
    console.warn('[slash] Could not clear commands:', e.message);
  }
  
  // Register new commands
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log('[slash] Global commands registered successfully');
}

// ───────────────────────────────────────────────────────────────────────────────
// Ready
// ───────────────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[ready] Logged in as ${client.user.tag}`);
  try { await registerSlashCommands(); } catch (e) {
    console.error('Failed to register slash commands:', e);
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Interaction handling
// ───────────────────────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

    // ───────────────────────────────────────────
    // /setup-bot
    // ───────────────────────────────────────────
    if (commandName === 'setup-bot') {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permissions.', ephemeral: true });
      }

      // Extract configuration from options
      const ticketCategory = interaction.options.getChannel('ticket_category', true);
      const logChannel = interaction.options.getChannel('log_channel', true);
      const approvalChannel = interaction.options.getChannel('approval_channel', true);
      const sessionChannel = interaction.options.getChannel('session_channel', true);
      const staffRole = interaction.options.getRole('staff_role', true);
      const adminRole = interaction.options.getRole('admin_role', true);
      const underInvestigationRole = interaction.options.getRole('under_investigation_role', true);

      // Validate channel types
      if (ticketCategory.type !== ChannelType.GuildCategory) {
        return interaction.reply({ content: 'Ticket category must be a category channel.', ephemeral: true });
      }
      if (![logChannel, approvalChannel, sessionChannel].every(c => c.type === ChannelType.GuildText)) {
        return interaction.reply({ content: 'Log, approval, and session channels must be text channels.', ephemeral: true });
      }

      // Store configuration
      const config = {
        ticketCategory: ticketCategory.id,
        logChannel: logChannel.id,
        approvalChannel: approvalChannel.id,
        sessionChannel: sessionChannel.id,
        staffRole: staffRole.id,
        adminRole: adminRole.id,
        underInvestigationRole: under_investigationRole.id,
        configuredAt: Date.now(),
        configuredBy: interaction.user.id
      };

      // Create setup confirmation
      const setupEmbed = new EmbedBuilder()
        .setTitle('🤖 Bot Setup Complete')
        .setDescription('All bot features have been configured successfully!')
        .setColor(0x2ecc71)
        .addFields(
          { name: 'Ticket Category', value: `<#${ticketCategory.id}>`, inline: true },
          { name: 'Log Channel', value: `<#${logChannel.id}>`, inline: true },
          { name: 'Approval Channel', value: `<#${approvalChannel.id}>`, inline: true },
          { name: 'Session Channel', value: `<#${sessionChannel.id}>`, inline: true },
          { name: 'Staff Role', value: `<@&${staffRole.id}>`, inline: true },
          { name: 'Admin Role', value: `<@&${adminRole.id}>`, inline: true },
          { name: 'Under Investigation Role', value: `<@&${underInvestigationRole.id}>`, inline: true }
        )
        .setTimestamp();

      // Send confirmation
      await interaction.reply({ embeds: [setupEmbed], ephemeral: true });
    }

    // ───────────────────────────────────────────
    // /staff-investigation
    // ───────────────────────────────────────────
    if (commandName === 'staff-investigation') {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: 'You need Moderate Members permissions.', ephemeral: true });
      }

      const member = interaction.options.getMember('member', true);
      const reason = interaction.options.getString('reason', true);

      const config = {
        underInvestigationRole: process.env.UNDER_INVESTIGATION_ROLE_ID,
        logChannel: process.env.LOG_CHANNEL_ID
      };

      if (!config.underInvestigationRole || !config.logChannel) {
        return interaction.reply({ content: 'Investigation role or log channel not configured.', ephemeral: true });
      }

      await member.roles.add(config.underInvestigationRole);
      await member.send(`You have been placed under investigation. Reason: ${reason}`).catch(() => {});
      
      const logEmbed = new EmbedBuilder()
        .setTitle('🔍 Staff Member Under Investigation')
        .setColor(0xff4757)
        .addFields(
          { name: 'Member', value: `${member.user.tag} (${member.id})`, inline: false },
          { name: 'Reason', value: reason, inline: false },
          { name: 'Investigated By', value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
          { name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
        );

      const logChannel = await interaction.guild.channels.fetch(config.logChannel).catch(() => null);
      if (logChannel && logChannel.isTextBased()) {
        await logChannel.send({ embeds: [logEmbed] });
      }

      return interaction.reply({ content: `Member placed under investigation. ✅`, ephemeral: true });
    }

    // ───────────────────────────────────────────
    // /rank-change
    // ───────────────────────────────────────────
    if (commandName === 'rank-change') {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.reply({ content: 'You need Manage Roles permissions.', ephemeral: true });
      }

      const member = interaction.options.getMember('member', true);
      const newRole = interaction.options.getRole('new_role', true);
      const reason = interaction.options.getString('reason', true);

      await member.roles.add(newRole);
      await member.send(`Your role has been changed to ${newRole.name}. Reason: ${reason}`).catch(() => {});

      const logEmbed = new EmbedBuilder()
        .setTitle('🎖️ Rank Change')
        .setColor(0x2ecc71)
        .addFields(
          { name: 'Member', value: `${member.user.tag} (${member.id})`, inline: false },
          { name: 'New Role', value: `<@&${newRole.id}>`, inline: false },
          { name: 'Reason', value: reason, inline: false },
          { name: 'Changed By', value: `${interaction.user.tag} (${interaction.id})`, inline: false }
        );

      const logChannel = await interaction.guild.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
      if (logChannel && logChannel.isTextBased()) {
        await logChannel.send({ embeds: [logEmbed] });
      }

      return interaction.reply({ content: `Role changed to ${newRole.name}. ✅`, ephemeral: true });
    }

    // ───────────────────────────────────────────
    // /setup-bot
    // ───────────────────────────────────────────
    if (commandName === 'setup-bot') {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permissions.', ephemeral: true });
      }

      const ticketCategory = interaction.options.getChannel('ticket_category', true);
      const logChannel = interaction.options.getChannel('log_channel', true);
      const approvalChannel = interaction.options.getChannel('approval_channel', true);
      const sessionChannel = interaction.options.getChannel('session_channel', true);

      // Validate channel types
      if (ticketCategory.type !== ChannelType.GuildCategory) {
        return interaction.reply({ content: 'Ticket category must be a category channel.', ephemeral: true });
      }
      if (![logChannel, approvalChannel, sessionChannel].every(c => c.type === ChannelType.GuildText)) {
        return interaction.reply({ content: 'Log, approval, and session channels must be text channels.', ephemeral: true });
      }

      // Create setup embed
      const setupEmbed = new EmbedBuilder()
        .setTitle('🤖 Bot Setup Complete')
        .setDescription('All bot features have been configured successfully!')
        .setColor(0x2ecc71)
        .addFields(
          { name: 'Ticket Category', value: `<#${ticketCategory.id}>`, inline: true },
          { name: 'Log Channel', value: `<#${logChannel.id}>`, inline: true },
          { name: 'Approval Channel', value: `<#${approvalChannel.id}>`, inline: true },
          { name: 'Session Channel', value: `<#${sessionChannel.id}>`, inline: true },
          { name: 'Instructions', value: 'Use /setup-assistance to post the assistance dropdown in any channel.' }
        )
        .setTimestamp();

      // Store configuration (in-memory for now)
      // In a real implementation, you'd store these in a database
      const config = {
        ticketCategory: ticketCategory.id,
        logChannel: logChannel.id,
        approvalChannel: approvalChannel.id,
        sessionChannel: sessionChannel.id,
        configuredAt: Date.now(),
        configuredBy: interaction.user.id
      };

      // Send confirmation
      await interaction.reply({ embeds: [setupEmbed], ephemeral: true });
    }

      // ───────────────────────────────────────────
      // /requestmsg
      // ───────────────────────────────────────────
      if (commandName === 'requestmsg') {
        const heading = interaction.options.getString('heading', true);
        const message = interaction.options.getString('message', true);
        const teamRole = interaction.options.getRole('team', true);

        // build the approval embed
        const requestEmbed = new EmbedBuilder()
          .setTitle(heading)
          .setDescription(`${message}\n\n**Regards,**\nThe ${teamRole.name}`)
          .setColor(0x2f80ed)
          .addFields(
            { name: 'Requester', value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
            {
              name: 'Requester Team Rank',
              value: interaction.member.roles.cache.has(teamRole.id) ? teamRole.name : `Not currently holding ${teamRole.name}`,
              inline: false
            },
            { name: 'Target Channel', value: `<#${interaction.channelId}>`, inline: false },
          )
          .setFooter({ text: `Requested by ${interaction.user.id} at ${new Date().toISOString()}` });

        const menu = new StringSelectMenuBuilder()
          .setCustomId('approvalMenu')
          .setPlaceholder('Approve or Decline…')
          .addOptions([
            { label: '✅ Approve The Message Broadcast', value: 'approve' },
            { label: '❌ Decline The Message Broadcast', value: 'decline' },
          ]);
        const row = new ActionRowBuilder().addComponents(menu);

        const approvalChannel = await interaction.guild.channels.fetch(APPROVAL_CHANNEL_ID);
        if (!approvalChannel || approvalChannel.type !== ChannelType.GuildText) {
          return interaction.reply({ content: 'Approval channel is misconfigured.', ephemeral: true });
        }

        const m = await approvalChannel.send({ embeds: [requestEmbed], components: [row] });
        approvalRequests.set(m.id, {
          targetChannelId: interaction.channelId,
          payloadEmbedData: { heading, message, teamRoleId: teamRole.id, teamRoleName: teamRole.name, requesterId: interaction.user.id },
        });

        return interaction.reply({ content: 'Your request has been sent for approval. ✅', ephemeral: true });
      }

      // ───────────────────────────────────────────
      // Moderation
      // ───────────────────────────────────────────
      if (['ban','kick','warn','timeout','untimeout','mute','unmute'].includes(commandName)) {
        // permissions quick checks
        const me = await interaction.guild.members.fetchMe();
        const mod = interaction.member;

        const requirePerm = (permName, bit) => {
          if (!mod.permissions.has(bit)) throw new Error(`You need ${permName}.`);
          if (!me.permissions.has(bit)) throw new Error(`I need ${permName}.`);
        };

        const logChannel = await interaction.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

        // user targets
        const targetUser = interaction.options.getUser('user', ['ban','kick','warn','timeout','untimeout','mute','unmute'].includes(commandName));
        const reason = interaction.options.getString('reason', ['ban','kick','warn','timeout','mute'].includes(commandName)) || 'No reason provided.';

        const sendLog = async (title, fields, color = 0xff4757) => {
          const embed = new EmbedBuilder().setTitle(title).setColor(color).addFields(fields).setTimestamp();
          if (logChannel && logChannel.isTextBased()) await logChannel.send({ embeds: [embed] });
        };

        try {
          if (commandName === 'ban') {
            requirePerm('BanMembers', PermissionFlagsBits.BanMembers);
            const member = await interaction.guild.members.fetch(targetUser.id);
            await targetUser.send(`You were banned from **${interaction.guild.name}**. Reason: ${reason}`).catch(()=>{});
            await member.ban({ reason });
            await sendLog('🔨 Ban', [
              { name: 'User', value: `${targetUser.tag} (${targetUser.id})` },
              { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})` },
              { name: 'Reason', value: reason },
              { name: 'Timestamp', value: fmtTime() },
            ]);
            return interaction.reply({ content: `Banned ${targetUser.tag}. ✅`, ephemeral: true });
          }

          if (commandName === 'kick') {
            requirePerm('KickMembers', PermissionFlagsBits.KickMembers);
            const member = await interaction.guild.members.fetch(targetUser.id);
            await targetUser.send(`You were kicked from **${interaction.guild.name}**. Reason: ${reason}`).catch(()=>{});
            await member.kick(reason);
            await sendLog('🚪 Kick', [
              { name: 'User', value: `${targetUser.tag} (${targetUser.id})` },
              { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})` },
              { name: 'Reason', value: reason },
              { name: 'Timestamp', value: fmtTime() },
            ]);
            return interaction.reply({ content: `Kicked ${targetUser.tag}. ✅`, ephemeral: true });
          }

          if (commandName === 'warn') {
            requirePerm('ModerateMembers', PermissionFlagsBits.ModerateMembers);
            await targetUser.send(`You were warned in **${interaction.guild.name}**. Reason: ${reason}`).catch(()=>{});
            await sendLog('⚠️ Warn', [
              { name: 'User', value: `${targetUser.tag} (${targetUser.id})` },
              { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})` },
              { name: 'Reason', value: reason },
              { name: 'Timestamp', value: fmtTime() },
            ], 0xf1c40f);
            return interaction.reply({ content: `Warned ${targetUser.tag}. ✅`, ephemeral: true });
          }

          if (commandName === 'timeout' || commandName === 'mute') {
            requirePerm('ModerateMembers', PermissionFlagsBits.ModerateMembers);
            const durationStr = interaction.options.getString('time', true);
            const ms = parseDuration(durationStr);
            if (!ms) return interaction.reply({ content: 'Invalid duration. Use formats like `10m`, `2h`, `1d`.', ephemeral: true });
            const member = await interaction.guild.members.fetch(targetUser.id);
            await targetUser.send(`You were timed out in **${interaction.guild.name}** for ${durationStr}. Reason: ${reason}`).catch(()=>{});
            await member.timeout(ms, reason);
            await sendLog('⏳ Timeout', [
              { name: 'User', value: `${targetUser.tag} (${targetUser.id})` },
              { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})` },
              { name: 'Duration', value: durationStr },
              { name: 'Reason', value: reason },
              { name: 'Timestamp', value: fmtTime() },
            ], 0x3498db);
            return interaction.reply({ content: `Timed out ${targetUser.tag} for ${durationStr}. ✅`, ephemeral: true });
          }

          if (commandName === 'untimeout' || commandName === 'unmute') {
            requirePerm('ModerateMembers', PermissionFlagsBits.ModerateMembers);
            const member = await interaction.guild.members.fetch(targetUser.id);
            await targetUser.send(`Your timeout was removed in **${interaction.guild.name}**.`).catch(()=>{});
            await member.timeout(null);
            await sendLog('✅ Timeout Removed', [
              { name: 'User', value: `${targetUser.tag} (${targetUser.id})` },
              { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})` },
              { name: 'Timestamp', value: fmtTime() },
            ], 0x2ecc71);
            return interaction.reply({ content: `Removed timeout for ${targetUser.tag}. ✅`, ephemeral: true });
          }
        } catch (err) {
          console.error(err);
          return interaction.reply({ content: `Failed: ${err.message}`, ephemeral: true });
        }
      }

      // ───────────────────────────────────────────
      // /session
      // ───────────────────────────────────────────
      if (commandName === 'session') {
        const sub = interaction.options.getSubcommand(true);
        const sessionChannel = await interaction.guild.channels.fetch(SESSION_CHANNEL_ID).catch(()=>null);
        if (!sessionChannel || !sessionChannel.isTextBased()) {
          return interaction.reply({ content: 'Session channel is misconfigured.', ephemeral: true });
        }

        if (sub === 'vote') {
          const q = interaction.options.getString('question', true);
          const embed = new EmbedBuilder()
            .setTitle('🗳️ Session Vote')
            .setDescription('A vote has been started for a new session.')
            .addFields({ name: 'Question', value: q })
            .setColor(0x8e44ad)
            .setTimestamp();

          const menu = new StringSelectMenuBuilder()
            .setCustomId('sessionVoteMenu')
            .setPlaceholder('Cast your vote…')
            .addOptions([
              { label: 'Yes', value: 'yes' },
              { label: 'No', value: 'no' },
              { label: 'Abstain', value: 'abstain' },
            ]);
          const row = new ActionRowBuilder().addComponents(menu);

          const sent = await sessionChannel.send({ embeds: [embed], components: [row] });
          sessionVotes.set(sent.id, { votes: new Map(), counts: { yes: 0, no: 0, abstain: 0 }, question: q });
          return interaction.reply({ content: 'Vote posted. ✅', ephemeral: true });
        }

        const map = {
          start:   { title: '🟢 Session Started',  msg: 'The session is now active.', color: 0x2ecc71 },
          shutdown:{ title: '🔴 Session Shutdown', msg: 'The session has ended.', color: 0xe74c3c },
          low:     { title: '🟡 Session Low',      msg: 'The session has low activity.', color: 0xf1c40f },
          full:    { title: '🔵 Session Full',     msg: 'The session is full.', color: 0x3498db },
        };
        const conf = map[sub];

        const embed = new EmbedBuilder()
          .setTitle(conf.title)
          .setDescription(conf.msg)
          .setColor(conf.color)
          .setTimestamp();

        await sessionChannel.send({ embeds: [embed] });
        return interaction.reply({ content: 'Posted. ✅', ephemeral: true });
      }
    }

    // ─────────────────────────────────────────────
    // Select Menus
    // ─────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      const { customId } = interaction;

      // Assistance channel dropdown (create ticket)
      if (customId === 'assistanceMenu') {
        const selected = interaction.values[0]; // category value
        const catInfo = CATEGORY_OPTIONS.find(c => c.value === selected);
        const categoryLabel = catInfo ? catInfo.label : selected;

        // create ticket channel under TICKET_CATEGORY_ID
        const guild = interaction.guild;
        const parent = guild.channels.cache.get(TICKET_CATEGORY_ID);
        if (!parent || parent.type !== ChannelType.GuildCategory) {
          return interaction.reply({ content: 'Ticket category is misconfigured.', ephemeral: true });
        }

        const safeName = `ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,12)}-${shortId()}`;

        const ccr = guild.roles.cache.get(CCR_ROLE_ID);
        const scr = guild.roles.cache.get(SCR_ROLE_ID);
        const teamRole = findTeamRoleByCategory(guild, selected);

        const overwrites = [
          { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ];
        if (ccr) overwrites.push({ id: ccr, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        if (scr) overwrites.push({ id: scr, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        if (teamRole) overwrites.push({ id: teamRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });

        const ticketChannel = await guild.channels.create({
          name: safeName,
          type: ChannelType.GuildText,
          parent: parent.id,
          permissionOverwrites: overwrites,
          topic: `Ticket for ${interaction.user.tag} | Category: ${categoryLabel}`,
        });

        // post claim dropdown (NO buttons)
        const claimEmbed = new EmbedBuilder()
          .setTitle(`🎟️ ${categoryLabel} Ticket`)
          .setDescription(`Welcome <@${interaction.user.id}>! A staff member will claim your ticket shortly.\n\n**Use the dropdown below to claim or manage this ticket.**`)
          .setColor(0x2d3436)
          .addFields(
            { name: 'Opened By', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Opened At', value: fmtTime(), inline: true },
          );

        const claimMenu = new StringSelectMenuBuilder()
          .setCustomId('ticketClaimMenu')
          .setPlaceholder('Select an action…')
          .addOptions([
            { label: '✅ Claim Ticket', value: 'claim' },
            { label: '🔓 Release Ticket', value: 'unclaim' },
            { label: '🗑️ Close Ticket', value: 'close' },
          ]);
        const row = new ActionRowBuilder().addComponents(claimMenu);

        await ticketChannel.send({ embeds: [claimEmbed], components: [row] });

        // optional gentle ping to related staff team
        if (teamRole) await ticketChannel.send({ content: `<@&${teamRole.id}>` }).catch(()=>{});

        // remember ticket state
        openTickets.set(ticketChannel.id, {
          openerId: interaction.user.id,
          categoryValue: selected,
          categoryLabel,
          optionClickedBy: interaction.user.id, // the user who chose the dropdown
          createdAt: Date.now(),
          claimedBy: null,
        });

        return interaction.reply({ content: `Your ticket has been created: <#${ticketChannel.id}> ✅`, ephemeral: true });
      }

      // Ticket claim/manage dropdown
      if (customId === 'ticketClaimMenu') {
        const action = interaction.values[0];
        const channel = interaction.channel;
        const state = openTickets.get(channel.id);
        if (!state) return interaction.reply({ content: 'This ticket is not tracked (possibly already closed).', ephemeral: true });

        // Only staff can claim/unclaim/close
        if (!isStaff(interaction.member)) {
          return interaction.reply({ content: 'Only staff can use this menu.', ephemeral: true });
        }

        if (action === 'claim') {
          if (state.claimedBy) {
            return interaction.reply({ content: `Already claimed by <@${state.claimedBy}>.`, ephemeral: true });
          }
          state.claimedBy = interaction.user.id;
          await channel.send({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`✅ Ticket claimed by <@${interaction.user.id}> at ${fmtTime()}`)] });
          // quick log (claim)
          const logCh = await channel.guild.channels.fetch(LOG_CHANNEL_ID).catch(()=>null);
          if (logCh?.isTextBased()) {
            await logCh.send({
              embeds: [
                new EmbedBuilder()
                  .setTitle('🎟️ Ticket Claimed')
                  .setColor(0x2ecc71)
                  .addFields(
                    { name: 'Channel', value: `<#${channel.id}>` },
                    { name: 'Claimed By', value: `<@${interaction.user.id}>` },
                    { name: 'Opened By', value: `<@${state.openerId}>` },
                    { name: 'Category', value: state.categoryLabel },
                    { name: 'Timestamp', value: fmtTime() },
                  )
              ]
            });
          }
          return interaction.reply({ content: 'You claimed this ticket. ✅', ephemeral: true });
        }

        if (action === 'unclaim') {
          if (state.claimedBy !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.reply({ content: 'Only the claimer or a manager can release.', ephemeral: true });
          }
          state.claimedBy = null;
          await channel.send({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setDescription(`🔓 Ticket released by <@${interaction.user.id}> at ${fmtTime()}`)] });
          return interaction.reply({ content: 'You released this ticket. ✅', ephemeral: true });
        }

        if (action === 'close') {
          // generate transcript, send to logs, then delete
          await interaction.deferReply({ ephemeral: true });
          const transcriptText = await buildTranscript(channel);
          const buf = Buffer.from(transcriptText || '(no messages)', 'utf8');
          const file = new AttachmentBuilder(buf, { name: `transcript-${channel.id}.txt` });

          const logCh = await channel.guild.channels.fetch(LOG_CHANNEL_ID).catch(()=>null);
          const embed = new EmbedBuilder()
            .setTitle('🗑️ Ticket Closed')
            .setColor(0xe74c3c)
            .addFields(
              { name: 'Channel', value: `#${channel.name} (${channel.id})` },
              { name: 'Opened By', value: `<@${state.openerId}>` },
              { name: 'Claimed/Responded By', value: state.claimedBy ? `<@${state.claimedBy}>` : 'Not claimed' },
              { name: 'Dropdown Category Chosen', value: `${state.categoryLabel}` },
              { name: 'Category Chosen By', value: `<@${state.optionClickedBy}>` },
              { name: 'Opened At', value: fmtTime(state.createdAt), inline: true },
              { name: 'Closed At', value: fmtTime(), inline: true },
              { name: 'Transcript', value: 'Attached as .txt (full).', inline: false },
            )
            .setTimestamp();

          if (logCh && logCh.isTextBased()) {
            await logCh.send({ embeds: [embed], files: [file] });
          }

          openTickets.delete(channel.id);
          await interaction.editReply({ content: 'Ticket closed & logged. ✅' });
          return channel.delete().catch(()=>{});
        }
      }

      // Approval dropdown (CCR/SCR only)
      if (customId === 'approvalMenu') {
        if (!hasAnyRole(interaction.member, [CCR_ROLE_ID, SCR_ROLE_ID])) {
          return interaction.reply({ content: 'Only CCR/SCR can act on approvals.', ephemeral: true });
        }

        const choice = interaction.values[0];
        const req = approvalRequests.get(interaction.message.id);
        if (!req) return interaction.reply({ content: 'This approval context has expired (bot restarted).', ephemeral: true });

        const { targetChannelId, payloadEmbedData } = req;
        const targetChannel = await interaction.guild.channels.fetch(targetChannelId).catch(()=>null);
        const teamRole = interaction.guild.roles.cache.get(payloadEmbedData.teamRoleId);

        if (choice === 'approve') {
          // build the broadcast embed
          const broadcast = new EmbedBuilder()
            .setTitle(payloadEmbedData.heading)
            .setDescription(`${payloadEmbedData.message}\n\n**Regards,**\nThe ${payloadEmbedData.teamRoleName}`)
            .setColor(0x2f80ed)
            .setTimestamp();

          if (targetChannel?.isTextBased()) {
            await targetChannel.send({ embeds: [broadcast] });
            if (teamRole) await targetChannel.send({ content: `<@&${teamRole.id}>` }).catch(()=>{});
          }
          await interaction.update({ components: [] });
          return interaction.followUp({ content: 'Approved & broadcasted. ✅', ephemeral: true });
        } else {
          await interaction.update({ components: [] });
          // Optionally notify requester via DM (if wanted)
          const requester = await interaction.client.users.fetch(payloadEmbedData.requesterId).catch(()=>null);
          requester?.send(`Your broadcast request "${payloadEmbedData.heading}" was declined by ${interaction.user.tag}.`).catch(()=>{});
          return interaction.followUp({ content: 'Declined. ✅', ephemeral: true });
        }
      }

      // Session vote selection
      if (customId === 'sessionVoteMenu') {
        const value = interaction.values[0]; // yes/no/abstain
        const entry = sessionVotes.get(interaction.message.id);
        if (!entry) return interaction.reply({ content: 'Vote session expired.', ephemeral: true });

        const prev = entry.votes.get(interaction.user.id);
        if (prev) entry.counts[prev] = Math.max(0, entry.counts[prev] - 1);
        entry.votes.set(interaction.user.id, value);
        entry.counts[value] += 1;

        const total = entry.counts.yes + entry.counts.no + entry.counts.abstain;
        const results = `**Yes:** ${entry.counts.yes} | **No:** ${entry.counts.no} | **Abstain:** ${entry.counts.abstain} | **Total:** ${total}`;

        const newEmbed = EmbedBuilder.from(interaction.message.embeds[0] ?? new EmbedBuilder())
          .setFields(
            { name: 'Question', value: entry.question },
            { name: 'Results', value: results },
          );

        await interaction.update({ embeds: [newEmbed] });
      }
    }
  } catch (err) {
    console.error('interaction error:', err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: `Error: ${err.message}`, ephemeral: true }); } catch {}
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────────
client.login(BOT_TOKEN);
