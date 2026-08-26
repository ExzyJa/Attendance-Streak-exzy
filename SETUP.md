# Attendance Streak Bot Setup Guide

This guide explains how to add the bot to Discord, configure attendance, and optionally enable automatic role changes.

## What the bot needs

### Required channel

Create one text channel for attendance, for example:

```text
#attendance
```

This is the only channel the bot needs. The bot posts the daily attendance message there.

There is no separate inactive channel. Inactive members are managed with the inactive Discord role. The bot does not currently send inactive notifications to another channel.

### Optional roles

Create these roles if you want automatic role management:

- `Active`: the role for members who are participating.
- `Inactive`: the role added when a member's streak reaches zero.
- `Exempt`: members with this role are completely protected from automatic role changes.

The role names can be anything. Select the actual roles in `/setup-attendance`.

## Add the bot to Discord

1. Open the Discord Developer Portal: https://discord.com/developers/applications
2. Select your application, or create a new application.
3. Open **Bot** and create the bot if needed.
4. Copy the bot token. Put it in `.env` as `DISCORD_TOKEN`.
5. Copy the application ID from **General Information**. Put it in `.env` as `CLIENT_ID`.
6. Open **OAuth2 -> URL Generator**.
7. Select these scopes:
   - `bot`
   - `applications.commands`
8. Select these bot permissions:
   - View Channels
   - Send Messages
   - Embed Links
   - Add Reactions
   - Read Message History
   - Manage Roles, only if role automation will be enabled
   - Mention Everyone, only if you want the daily `@everyone` mention
9. Open the generated invite URL and select your Discord server.

The bot must be above the `Active` and `Inactive` roles in **Server Settings -> Roles**. Discord does not allow a bot to manage roles at or above its highest role.

## Configure the project

From the project folder:

```bash
npm install
```

Create `.env` from the example file and fill in your values:

```env
DISCORD_TOKEN=your-bot-token
CLIENT_ID=your-application-client-id
```

For Railway or another persistent volume, also set:

```env
DB_PATH=/data/attendance.sqlite
```

Register the slash commands:

```bash
npm run deploy-commands
```

Start the bot:

```bash
npm start
```

## Configure attendance only

If you do not want automatic role changes, run `/setup-attendance` and leave role automation disabled.

Use these values:

```text
channel: #attendance
time: 09:00
timezone: Asia/Manila
enable-role-automation: false
```

Attendance posts, check-ins, streaks, shields, `/streaks`, and `/my-streak` will work. The bot will not add or remove roles.

## Configure attendance and roles

Run `/setup-attendance` as a moderator with the Manage Server permission.

Example:

```text
channel: #attendance
time: 09:00
timezone: Asia/Manila
enable-role-automation: true
active-role: @Active
inactive-role: @Inactive
exemption-role: @Exempt
```

The `active-role` and `inactive-role` options are required when role automation is enabled. The exemption role is optional.

## How automatic roles work

1. A member reacts with the checkmark on the current attendance post.
2. The bot records the member's attendance and updates the streak.
3. If the streak reaches zero after absence processing, the bot saves the member's current roles.
4. The bot removes the active role and adds the inactive role.
5. If the member checks in again, the bot removes the inactive role and restores the active role.
6. Members who have the exemption role are never changed by the bot.

The bot can only change roles below its highest role and only when it has the Manage Roles permission.

## Forgive an inactive member

A moderator can restore the roles saved before the inactive transition:

```text
/forgive-inactive user:@Member
```

This removes the inactive role and restores the saved roles. It requires Manage Server permission.

If the member is exempt, or there is no saved role snapshot, the command does nothing.

## Commands

| Command | Who can use it | Purpose |
|---|---|---|
| `/setup-attendance` | Manage Server | Set the attendance channel, time, timezone, and optional role automation. |
| `/post-attendance-now` | Anyone with command access | Post an attendance message immediately for testing. |
| `/streaks` | Anyone | Show the current streak leaderboard. |
| `/my-streak` | Anyone | Show your current streak and shields privately. |
| `/forgive-inactive user` | Manage Server | Restore a member's saved roles and remove the inactive role. |

## Disable role automation

Run `/setup-attendance` again with:

```text
enable-role-automation: false
```

Attendance and streak tracking continue. The bot stops automatic role changes. The selected attendance channel remains active.

## Important notes

- Only reactions on the current attendance message count.
- The bot uses the configured timezone for daily attendance boundaries.
- The bot stores data in `attendance.sqlite` unless `DB_PATH` is configured.
- If the bot restarts, the database preserves streaks, shields, settings, and saved role snapshots.
- After changing slash-command definitions, run `npm run deploy-commands` again.
