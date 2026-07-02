# 24x7 Bluesky Bot Setup

The bot runs from GitHub Actions every ten minutes. It replies only to unread
Bluesky mentions. Each reply contains a 720x1280 screenshot of the real 24x7 app,
plus a link to:

https://dsparks.github.io/24x7/

## What you need to do

### 1. Commit and push this code

The workflow does not exist on GitHub until these files are committed and pushed
to the `main` branch.

### 2. Create the Bluesky account

1. Create a dedicated Bluesky account for the bot.
2. Give it a recognizable display name, such as `24x7 Weather`.
3. Use the 24x7 icon as its avatar.
4. Put this in its profile description:

   `Mention me with a location for a 24x7 weather grid. Automated bot. Forecasts from Open-Meteo. dsparks.github.io/24x7`

5. In the account's moderation/profile settings, label the account as a bot if
   Bluesky presents that option.

The handle can be anything. The example in the tests is
`24x7weather.bsky.social`, but the code does not depend on that handle.

### 3. Create an app password

While signed in to the bot account:

1. Open Bluesky Settings.
2. Open Privacy and security.
3. Open App passwords.
4. Choose Add app password.
5. Name it `GitHub 24x7 bot`.
6. Copy the generated password immediately.

Do not use the bot account's normal password.

### 4. Add two GitHub Actions secrets

Open:

`https://github.com/dsparks/24x7/settings/secrets/actions`

Choose **New repository secret** and create both:

| Secret | Exact value |
| --- | --- |
| `BLUESKY_IDENTIFIER` | The bot's full handle, such as `24x7weather.bsky.social` |
| `BLUESKY_APP_PASSWORD` | The app password generated in step 3 |

Do not include `@` in `BLUESKY_IDENTIFIER`.

### 5. Verify repository Actions permissions

Open:

`https://github.com/dsparks/24x7/settings/actions`

Under **Actions permissions**, allow GitHub Actions to run. The workflow needs
only read access to repository contents; it does not commit or modify the repo.

### 6. Test screenshot generation without posting

1. Open `https://github.com/dsparks/24x7/actions`.
2. Select **Bluesky weather bot**.
3. Choose **Run workflow**.
4. Leave mode set to **dry-run**.
5. Enter a test location, such as `Boston, MA`.
6. Choose **Run workflow**.
7. Open the completed workflow run.
8. Download the `24x7-bot-preview` artifact at the bottom of the run.
9. Open `bot-output.jpg` and confirm the grid, location, and branding look right.

A dry run does not log in to Bluesky and cannot post anything.

### 7. Test one real reply

1. On Bluesky, make a post that mentions the bot and includes a location:

   `@your-bot-handle Boston, MA`

2. Return to **Actions > Bluesky weather bot > Run workflow**.
3. Change mode to **live**.
4. Choose **Run workflow**.
5. The bot should reply to the mention with an image and the 24x7 site link.

After that test, the scheduled workflow will check automatically at minutes
3, 13, 23, 33, 43, and 53 of every hour once you enable it in the next step.

### 8. Enable automatic scheduled replies

Do this only after the real-reply test succeeds:

1. Open `https://github.com/dsparks/24x7/settings/variables/actions`.
2. Choose **New repository variable**.
3. Name it exactly `BLUESKY_BOT_ENABLED`.
4. Set its value to exactly `true`.
5. Choose **Add variable**.

Scheduled runs are skipped until that variable exists. GitHub may occasionally
start a scheduled run a few minutes late.

## Supported mention styles

- `@bot Boston, MA`
- `@bot weather for London, UK`
- `forecast in Tokyo @bot`

If the location is missing, the bot replies with an example. If Open-Meteo
cannot find it, the bot asks for a more specific city/state/country.

## Operational notes

- The bot uses a deterministic reply record key derived from the mentioned post
  and its author. Retrying a completed workflow cannot create a duplicate reply.
- Per-mention progress lives in a small state file (`BOT_STATE_FILE`, persisted
  between scheduled runs with `actions/cache`), not in Bluesky's read markers.
  Mentions are cursor-paginated, so backlogs deeper than 100 are still handled.
- A failed mention is retried on later runs, up to 3 attempts; after that the
  bot replies with a brief apology and moves on, so one bad mention can never
  block the queue.
- The ten-minute schedule stays comfortably below Bluesky's daily login limit.
- GitHub disables scheduled workflows in public repositories after 60 days with
  no repository activity. A commit or manual workflow run re-enables them.
