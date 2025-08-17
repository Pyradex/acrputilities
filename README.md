# 📘 ACRP Utilities (Slash-Only)

Clean, minimal, **3-file** Discord bot that delivers:

- **Ticket System**
  - Assistance channel **dropdown only** (no embed text)
  - Tickets created under **Your Tickets** category (by **ID**)
  - Staff **claim via dropdown** (NO buttons)
  - Logs to a channel as **clean embeds**
  - Logs include **who opened**, **who claimed/responded**, **which dropdown was clicked**, **transcript**
  - Transcript captured on close and **attached** as `.txt`

- **Team Message Request & Approval**
  - `/requestmsg heading:<text> message:<text> team:<role>`
  - Sends to private **Approval** channel (CCR/SCR only)
  - **Approve/Decline** via dropdown; on approve, bot **broadcasts** to the channel where the command was run

- **Moderation (Slash)**
  - `/ban`, `/kick`, `/warn`, `/timeout`, `/untimeout`, `/mute`, `/unmute`
  - All punishments: **embed in channel** + **DM to user** + **log embed**

- **Session System**
  - `/session vote/start/shutdown/low/full` → posts embeds to **SESSION_CHANNEL_ID**
  - Vote uses dropdown (Yes/No/Abstain) with live tallies

- **Minimal Deploy**
  - No `.env` file; use **Render.com** environment variables
  - Keep-alive via a tiny web server (for UptimeRobot pings)
  - Single code file: `index.js`

---

## ✅ Requirements

**Enable Intents in Discord Developer Portal (Bot → Privileged Gateway Intents):**
- `SERVER MEMBERS INTENT`
- `MESSAGE CONTENT INTENT`

**Bot Permissions in your server:**
- Manage Channels, Read/Send Messages, Read Message History
- Moderate Members (for timeout)
- Kick Members (for kick)
- Ban Members (for ban)

---

## 🔧 Environment Variables (Render)

Create a **Web Service** or **Background Worker** on Render and set:

- `BOT_TOKEN` → Your bot token
- `TICKET_CATEGORY_ID` → The **category ID** where tickets are created
- `LOG_CHANNEL_ID` → Channel ID for ticket/moderation logs
- `APPROVAL_CHANNEL_ID` → Channel ID for CCR/SCR-only approvals
- `SESSION_CHANNEL_ID` → Channel ID for session posts
- `CCR_ROLE_ID` → CCR role ID
- `SCR_ROLE_ID` → SCR role ID

> Teams are matched by **name** in your server:  
> `Game Team`, `Chain Team`, `Support Team`, `QA Team`, `Media Team`, `Event Team`.  
> (No extra env vars needed.)

---

## ▶️ Local Run (optional)

```bash
# Node 18+ required
npm i
BOT_TOKEN=... TICKET_CATEGORY_ID=... LOG_CHANNEL_ID=... \
APPROVAL_CHANNEL_ID=... SESSION_CHANNEL_ID=... \
CCR_ROLE_ID=... SCR_ROLE_ID=... node index.js
