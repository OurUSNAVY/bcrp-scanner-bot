# BCRP Scanner Bot

Relays audio from a Discord voice channel (RTO) to the BCRP Phone app in real-time.

## Requirements

- Node.js 18 or higher
- A server with outbound UDP access (Railway, Render, any VPS)

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Set the following environment variables (or create a `.env` file):

   | Variable | Value |
   |---|---|
   | `DISCORD_BOT_TOKEN` | Your Discord bot token |
   | `SCANNER_BOT_GUILD_ID` | Discord server (guild) ID |
   | `SCANNER_CHANNEL_ID` | RTO voice channel ID |
   | `SCANNER_WS_URL` | `wss://phone.blainecountyroleplay.network/internal/scanner-feed` |
   | `SCANNER_INTERNAL_SECRET` | Shared secret (must match `SCANNER_INTERNAL_SECRET` on the API server) |

3. Start the bot:
   ```
   npx tsx src/index.ts
   ```

## Railway deployment (recommended)

1. Push this folder to a GitHub repo (or use Railway's CLI)
2. Create a new Railway project → Deploy from GitHub
3. Add the environment variables above in Railway's Variables panel
4. Set the start command to: `npx tsx src/index.ts`

## How it works

1. Bot logs into Discord and joins the configured voice channel
2. As users speak, their Opus audio packets are decoded to PCM
3. All speakers are mixed into a single stereo 48kHz stream
4. Mixed audio is sent via WebSocket to the BCRP API server
5. The API server broadcasts it to all subscribed scanner users on the phone app
