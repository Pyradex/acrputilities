# bot.py
import discord
from discord import app_commands
from discord.ext import commands, tasks
import asyncio
import time
import json
import os
from utils import init_db, save_setup, load_setup, create_ticket_record, set_ticket_claim, get_ticket, clear_ticket

# Initialize DB
init_db()

# Load basic config (token + optional defaults)
with open("config.json", "r", encoding="utf-8") as f:
    CONFIG = json.load(f)

TOKEN = CONFIG.get("token")
if not TOKEN or TOKEN == "YOUR_BOT_TOKEN_HERE":
    raise RuntimeError("Please set your bot token in config.json before running.")

intents = discord.Intents.default()
intents.members = True
intents.message_content = False

bot = commands.Bot(command_prefix="!", intents=intents)
tree = bot.tree

# The six professional responses EXACTLY as requested
PROFESSIONAL_PHRASES = [
    "Your professional response to this ticket would be greatly appreciated.",
    "If you choose to respond to this ticket, please do so professionally—it will be much appreciated.",
    "A professional and courteous reply to this ticket would be sincerely valued.",
    "Should you wish to respond, a professional approach will be greatly respected and appreciated.",
    "We kindly ask that any response to this ticket remain professional, which would be appreciated.",
    "Your professional input on this ticket would be most appreciated."
]

# Helper to build the embed text as you requested for General Support Tickets
def build_public_ticket_embed(ticket_type: str, user: discord.Member, issue_text: str) -> discord.Embed:
    if ticket_type == "general":
        heading = "**A Community Member has created a General Support Ticket**"
    else:
        heading = "**A Community Member has created a Community Support Ticket**"
    # randomize one of the six phrases
    import random
    phrase = random.choice(PROFESSIONAL_PHRASES)
    embed = discord.Embed(title=heading, color=discord.Color.blurple())
    embed.add_field(name="User", value=f"<@{user.id}>", inline=False)
    embed.add_field(name="Issue", value=issue_text or "(No issue text provided)", inline=False)
    embed.add_field(name="\u200b", value=phrase, inline=False)
    embed.add_field(name="\u200b", value="Click the dropdown embed below to claim this ticket, and if it is already claimed, you cannot access it unless you are added to that ticket by a staff member or Internal Affairs+", inline=False)
    return embed

# Setup command: stores configuration in the DB.
# This implements every attribute you requested: [Assistance Channel], [General Support Requests], [Community Support Requests], [GSAccess], [CSAccess], [LOA Role ID], [ticket logs channel id]
@tree.command(name="setup_support", description="Configure the ACRP Utilities Support System fully.")
@app_commands.describe(
    assistance_channel_id="Channel ID for assistance channel (where the dropdown will be posted).",
    general_requests_channel_id="Channel ID where General Support Ticket public embeds are sent.",
    community_requests_channel_id="Channel ID where Community Support Ticket public embeds are sent.",
    gsaccess="Comma-separated role IDs that have Level 1 access (ANY and ALL General Support Tickets at ALL TIMES EXCEPT WHEN THEY ARE CLOSED).",
    csaccess="Comma-separated role IDs that have Level 2 access (ANY and ALL COMMUNITY Support Tickets at ALL TIMES EXCEPT WHEN THEY ARE CLOSED).",
    loa_role_id="Role ID for LOA Role (members with this role will NOT receive pings to join tickets).",
    ticket_logs_channel_id="Channel ID where every ticket will be logged.",
    category_id="Category ID where ticket channels should be created."
)
async def setup_support(interaction: discord.Interaction,
                        assistance_channel_id: int,
                        general_requests_channel_id: int,
                        community_requests_channel_id: int,
                        gsaccess: str,
                        csaccess: str,
                        loa_role_id: int,
                        ticket_logs_channel_id: int,
                        category_id: int):
    # parse gsaccess and csaccess (comma-separated)
    def parse_role_list(s: str):
        s = s.strip()
        if not s:
            return []
        parts = [p.strip() for p in s.split(",") if p.strip()]
        out = []
        for p in parts:
            try:
                out.append(int(p))
            except:
                pass
        return out

    gs_list = parse_role_list(gsaccess)
    cs_list = parse_role_list(csaccess)

    save_setup(assistance_channel_id, general_requests_channel_id, community_requests_channel_id,
               gs_list, cs_list, loa_role_id, ticket_logs_channel_id, category_id)

    # confirm to the invoker with ephemeral message (private flagged)
    await interaction.response.send_message("Support system configuration saved successfully.", ephemeral=True)

    # After saving, attempt to post a dropdown message in the assistance channel describing how to open tickets.
    cfg = load_setup()
    ass_ch = interaction.guild.get_channel(cfg["assistance_channel_id"]) if cfg["assistance_channel_id"] else None
    if ass_ch:
        embed = discord.Embed(title="Support System: Ticket Creation", description="Use the dropdown below to create a new ticket. Choose General Support or Community Support and provide your issue when prompted.", color=discord.Color.green())
        # We'll send a message with a select menu to open a ticket
        class TicketSelect(discord.ui.Select):
            def __init__(self):
                options = [
                    discord.SelectOption(label="Open General Support Ticket", value="general", description="Create a General Support ticket."),
                    discord.SelectOption(label="Open Community Support Ticket", value="community", description="Create a Community/HR Support ticket.")
                ]
                super().__init__(placeholder="Create a ticket...", min_values=1, max_values=1, options=options)

            async def callback(self, interaction: discord.Interaction):
                choice = self.values[0]
                # open a modal to collect issue description
                class IssueModal(discord.ui.Modal, title="Open Ticket"):
                    issue = discord.ui.TextInput(label="Issue description", style=discord.TextStyle.long, placeholder="Describe the issue you need help with", required=True, max_length=2000)

                    async def on_submit(self, modal_interaction: discord.Interaction):
                        # create ticket channel
                        cfg = load_setup()
                        guild = modal_interaction.guild
                        category = guild.get_channel(cfg["category_id"]) if cfg["category_id"] else None
                        # create a private channel under category with appropriate permissions
                        overwrites = {
                            guild.default_role: discord.PermissionOverwrite(view_channel=False),
                            modal_interaction.user: discord.PermissionOverwrite(view_channel=True, send_messages=True),
                        }
                        # Staff roles specified in gsaccess/csaccess should get view access
                        role_ids = cfg["gsaccess"] if choice == "general" else cfg["csaccess"]
                        # Add each role with view permissions, but skip LOA role members (LOA is a role id which we won't give pings to, but still giving role view permission is fine)
                        for rid in role_ids:
                            role = guild.get_role(rid)
                            if role:
                                overwrites[role] = discord.PermissionOverwrite(view_channel=True, send_messages=True)
                        # Create channel name
                        safe_name = f"ticket-{modal_interaction.user.name}".lower()
                        ticket_channel = await guild.create_text_channel(safe_name, overwrites=overwrites, category=category, reason="New support ticket created via ACRP Utilities")
                        # Save ticket record
                        create_ticket_record(ticket_channel.id, modal_interaction.user.id, choice, self.issue.value, int(time.time()))
                        # Send ticket embed inside ticket channel (visible to authorized roles + author)
                        embed_ticket = discord.Embed(title=f"Ticket — {choice.capitalize()}",
                                                     description=f"Ticket created by <@{modal_interaction.user.id}>",
                                                     color=discord.Color.blue())
                        embed_ticket.add_field(name="User", value=f"<@{modal_interaction.user.id}>", inline=False)
                        embed_ticket.add_field(name="Issue", value=self.issue.value, inline=False)
                        embed_ticket.add_field(name="Status", value="Open", inline=False)
                        await ticket_channel.send(embed=embed_ticket)
                        # Post public embed in the appropriate requests channel (public notification)
                        if choice == "general":
                            public_ch = guild.get_channel(cfg["general_requests_channel_id"])
                        else:
                            public_ch = guild.get_channel(cfg["community_requests_channel_id"])
                        if public_ch:
                            public_embed = build_public_ticket_embed(choice, modal_interaction.user, self.issue.value)
                            # send public embed and include a view with a claim select for staff
                            # We'll send a message with a dropdown that allows staff to claim
                            class ClaimSelect(discord.ui.Select):
                                def __init__(self):
                                    options = [discord.SelectOption(label="Claim this ticket", value=str(ticket_channel.id))]
                                    super().__init__(placeholder="Claim this ticket...", min_values=1, max_values=1, options=options)

                                async def callback(self, select_interaction: discord.Interaction):
                                    # Only staff roles may claim — check role lists
                                    cfg = load_setup()
                                    allowed_role_ids = cfg["gsaccess"] if choice == "general" else cfg["csaccess"]
                                    member_roles = [r.id for r in select_interaction.user.roles]
                                    # Check if user has LOA role
                                    loa = cfg.get("loa_role_id")
                                    if loa and loa in member_roles:
                                        # LOA role prevents pings/participation - disallow claiming
                                        await select_interaction.response.send_message("You are marked LOA and cannot claim tickets.", ephemeral=True)
                                        return
                                    if not any(rid in member_roles for rid in allowed_role_ids):
                                        await select_interaction.response.send_message("You do not have permission to claim this ticket.", ephemeral=True)
                                        return
                                    # check if already claimed
                                    ticket = get_ticket(ticket_channel.id)
                                    if ticket and ticket.get("claimed_by"):
                                        # Already claimed
                                        claimer_id = ticket["claimed_by"]
                                        embed_already = discord.Embed(title="Ticket Already Claimed", description="This ticket is already claimed.", color=discord.Color.red())
                                        embed_already.add_field(name="Claimed by", value=f"<@{claimer_id}>", inline=False)
                                        await select_interaction.response.send_message(embed=embed_already, ephemeral=True)
                                        return
                                    # claim it
                                    set_ticket_claim(ticket_channel.id, select_interaction.user.id)
                                    # grant selecting user access to the ticket channel (if they don't already have)
                                    await ticket_channel.set_permissions(select_interaction.user, view_channel=True, send_messages=True)
                                    # send a private embed message inside the ticket channel to indicate claim
                                    embed_claim = discord.Embed(title="Ticket Claimed", description=f"This ticket has been claimed by <@{select_interaction.user.id}>", color=discord.Color.gold())
                                    await ticket_channel.send(embed=embed_claim)
                                    # send ephemeral confirmation to claimer
                                    await select_interaction.response.send_message("You have successfully claimed the ticket.", ephemeral=True)
                                    # log claim in ticket logs channel if configured
                                    logs_ch = guild.get_channel(cfg["ticket_logs_channel_id"]) if cfg["ticket_logs_channel_id"] else None
                                    if logs_ch:
                                        log_embed = discord.Embed(title="Ticket Claimed", description=f"Ticket {ticket_channel.mention} claimed by <@{select_interaction.user.id}>", color=discord.Color.dark_gray())
                                        await logs_ch.send(embed=log_embed)

                            view = discord.ui.View()
                            view.add_item(ClaimSelect())
                            await public_ch.send(embed=public_embed, view=view)
                        # Respond to the modal submitter ephemeral confirmation
                        await modal_interaction.response.send_message(f"Your ticket has been created: {ticket_channel.mention}", ephemeral=True)

                modal = IssueModal()
                await interaction.response.send_modal(modal)

        view = discord.ui.View()
        view.add_item(TicketSelect())
        try:
            await ass_ch.send(embed=embed, view=view)
        except Exception:
            # ignore send failures
            pass

# add_user command: pings a user in the assistance channel as a private flagged message that asks them to join
@tree.command(name="add_user", description="Ping a user in the assistance channel requesting them to join (private flagged in the assistance channel).")
@app_commands.describe(user="User to ping")
async def add_user(interaction: discord.Interaction, user: discord.Member):
    cfg = load_setup()
    ass_ch_id = cfg.get("assistance_channel_id")
    if not ass_ch_id:
        await interaction.response.send_message("Support system is not configured. Use /setup_support first.", ephemeral=True)
        return
    ass_ch = interaction.guild.get_channel(ass_ch_id)
    if not ass_ch:
        await interaction.response.send_message("Assistance channel not found. Check setup values.", ephemeral=True)
        return

    # Build the embed that requests them to join
    embed = discord.Embed(title="Support Invitation", description=f"{user.mention}, you have been requested to join support. Please join when ready.", color=discord.Color.blue())
    embed.add_field(name="Request", value="A staff member has requested that you join the support conversation. Please accept if you are available.", inline=False)
    embed.add_field(name="Instructions", value="Reply in the assistance channel or open the ticket when asked.", inline=False)

    # The user asked that this "pings them in support (as a PRIVATE message in support assistance channel) and requests them to join which shows a beautiful embed and tells them whether or not to join."
    # We will send the embed publicly in the assistance channel but immediately follow with an ephemeral message to the invoker confirming the ping was sent.
    await ass_ch.send(content=user.mention, embed=embed)
    await interaction.response.send_message("User has been pinged in the assistance channel.", ephemeral=True)

# claim command: works only in ticket channels. If already claimed, show "it is already claimed" as a beautiful private embed.
@tree.command(name="claim", description="Claim the ticket in this channel (only works inside a ticket channel).")
async def claim(interaction: discord.Interaction):
    cfg = load_setup()
    channel = interaction.channel
    ticket = get_ticket(channel.id)
    if not ticket:
        await interaction.response.send_message("This command only works inside a ticket channel.", ephemeral=True)
        return
    # Check claimant permissions: must be in corresponding role lists
    ttype = ticket["type"]
    allowed_role_ids = cfg["gsaccess"] if ttype == "general" else cfg["csaccess"]
    member_role_ids = [r.id for r in interaction.user.roles]
    # LOA check
    loa = cfg.get("loa_role_id")
    if loa and loa in member_role_ids:
        await interaction.response.send_message("You are marked LOA and cannot claim tickets.", ephemeral=True)
        return
    if not any(rid in member_role_ids for rid in allowed_role_ids):
        await interaction.response.send_message("You do not have permission to claim this ticket.", ephemeral=True)
        return
    # check claimed
    if ticket.get("claimed_by"):
        claimer = ticket["claimed_by"]
        embed_already = discord.Embed(title="Ticket Already Claimed", description="This ticket is already claimed", color=discord.Color.red())
        embed_already.add_field(name="Claimed by", value=f"<@{claimer}>", inline=False)
        await interaction.response.send_message(embed=embed_already, ephemeral=True)
        return
    # claim
    set_ticket_claim(channel.id, interaction.user.id)
    # give claimant channel permissions
    await channel.set_permissions(interaction.user, view_channel=True, send_messages=True)
    embed_claim = discord.Embed(title="Ticket Claimed", description=f"This ticket has been claimed by <@{interaction.user.id}>", color=discord.Color.gold())
    await channel.send(embed=embed_claim)
    await interaction.response.send_message("You have successfully claimed the ticket.", ephemeral=True)

# Close ticket command for staff
@tree.command(name="close_ticket", description="Close the current ticket (staff only).")
async def close_ticket(interaction: discord.Interaction):
    cfg = load_setup()
    channel = interaction.channel
    ticket = get_ticket(channel.id)
    if not ticket:
        await interaction.response.send_message("This command only works inside a ticket channel.", ephemeral=True)
        return
    # only allowed staff may close: use gsaccess + csaccess union
    allowed_role_ids = set(cfg.get("gsaccess", []) + cfg.get("csaccess", []))
    member_role_ids = {r.id for r in interaction.user.roles}
    if not allowed_role_ids.intersection(member_role_ids):
        await interaction.response.send_message("You do not have permission to close this ticket.", ephemeral=True)
        return
    # Log the ticket
    logs_ch = interaction.guild.get_channel(cfg.get("ticket_logs_channel_id")) if cfg.get("ticket_logs_channel_id") else None
    if logs_ch:
        log_embed = discord.Embed(title="Ticket Closed", description=f"Ticket {channel.mention} closed by <@{interaction.user.id}>", color=discord.Color.dark_gray())
        log_embed.add_field(name="Original Author", value=f"<@{ticket['author_id']}>", inline=False)
        log_embed.add_field(name="Type", value=ticket['type'], inline=True)
        log_embed.add_field(name="Claimed by", value=(f"<@{ticket['claimed_by']}>" if ticket['claimed_by'] else "Unclaimed"), inline=True)
        if ticket.get("description"):
            log_embed.add_field(name="Description", value=ticket['description'], inline=False)
        await logs_ch.send(embed=log_embed)
    # Delete ticket record
    clear_ticket(channel.id)
    await channel.delete(reason=f"Ticket closed by {interaction.user}")

# On ready: sync commands
@bot.event
async def on_ready():
    await tree.sync()
    print(f"Logged in as {bot.user} (ID: {bot.user.id})")
    print("Commands synced.")

# Run the bot
if __name__ == "__main__":
    bot.run(TOKEN)
