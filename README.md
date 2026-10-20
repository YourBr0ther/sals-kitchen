<p align="center">
  <img src="assets/banner.png" alt="Sal's Kitchen" width="100%">
</p>

# Sal's Kitchen

Sal is a personal chef who lives in a chat window. He's an older guy, he's been cooking forever, and he's funny about it. You tell him what kind of week you're having. He checks the family calendar, works out which nights anyone can cook, and fills those nights with meals the household will eat. Then the plan goes to [Mealie](https://mealie.io), the self-hosted recipe manager we already use.

The goal is simple. We want to cook at home more, and planning was always the part that killed it.

<p align="center">
  <img src="docs/mobile.png" alt="Phone screens: PIN login, chat with Sal, the week ticket, and taste profiles" width="100%">
</p>

## What Sal does

**Plans the week.** The week is a kitchen ticket next to the chat. Sal reads a shared calendar and crosses off busy evenings (practice, date night, travel). He fills the rest with meals and writes them straight onto the ticket. Anyone can flip a night on or off, or clear a dish, with one tap. When it looks right, a grown-up taps "Send to Mealie" and each night becomes a dinner on Mealie's meal plan. Sending again replaces those dinners instead of duplicating them.

**Starts with your recipe box.** Mealie is the source of truth for recipes. Sal searches it first, because a recipe you've already made once is the one you'll make again. He also checks recent dinners so he doesn't repeat last week.

**Finds new things on the web.** Ask for something new and Sal searches the web, reads the recipe page, and pitches one or two with a link. He only pitches pages that actually contain a recipe, so roundup posts get skipped. If you like one, he asks to save it into Mealie with its photo. Recipe blogs without structured data, and sites that block bots, work too. See [reading recipes from the web](docs/architecture.md#reading-recipes-from-the-web).

**Learns what everyone likes.** Each person has a taste profile: favorites, won't-eat, allergies, and things Sal noticed. Sal fills it in from conversation. Everyone can see everyone's profile. You edit your own, and grown-ups look after the kids'. Allergies and won't-eats are hard rules for the planner.

**Asks before changing anything that matters.** Saving a recipe to Mealie and changing a profile show an approve button in the chat. Nothing runs until a person taps it. The week ticket is a draft, so Sal edits it freely.

## Talking to him

- Text
- Voice notes. Tap the mic, talk, tap again. It gets transcribed and Sal answers
- Links. Paste a recipe URL and Sal reads it
- Photos. Your fridge, a cookbook page, a dish you had out. A vision model describes the photo and Sal works from that

He talks like a guy who's run a kitchen for forty years and has stories about most of it. He keeps it short, because you're usually reading him in a grocery store. Persona notes are in [`docs/chef-persona.md`](docs/chef-persona.md).

<p align="center">
  <img src="docs/screenshot.png" alt="Desktop layout: sidebar, chat with Sal, and the week ticket" width="100%">
</p>

## How it works

```
 phone or laptop
        |
        v
 Next.js app  ----->  chat model (OpenAI-compatible API, tool calling)
   |  PIN login        tools: search_recipes, get_recipe, recent_dinners,
   |  chat (SSE)              get_week, plan_nights, web_search, read_link,
   |  week ticket             import_recipe_url*, update_profile*
   |  profiles         (* waits for a person to approve)
   |
   +--> Mealie REST API   recipes, URL import, meal plans
   +--> ICS calendar feed busy evenings
   +--> SQLite            people, sessions, profiles, chat, week drafts
```

Each message runs a tool-calling loop. The model decides when to search the box, check the week, or write to the ticket. The server runs those tools and streams Sal's reply back as it's written. Tool calls and results are saved with the conversation, so Sal remembers what he looked up last turn.

More detail is in [`docs/architecture.md`](docs/architecture.md).

## Running it

You need a Mealie instance, a Mealie API token (Mealie > your profile > API Tokens), and an API key for an OpenAI-compatible provider. It was built against [NanoGPT](https://nano-gpt.com), which also covers web search and speech-to-text.

```sh
cd web
cp ../.env.example .env.local   # fill it in
npm install
npm run dev
```

Open the app. The first visit goes to a setup page where you add the household: grown-ups with a 4-digit PIN, kids without one.

### Docker

```sh
cd web
docker build -t sals-kitchen .
docker run -p 3000:3000 -v sal-data:/data --env-file .env.local sals-kitchen
```

The SQLite database and uploaded photos live in `/data`. `GET /api/health` is there for probes.

## Configuration

| Variable | What it's for |
|---|---|
| `LLM_BASE_URL`, `LLM_API_KEY` | OpenAI-compatible endpoint and key |
| `LLM_MODEL` | Chat model. Must handle tool calls well. Default `z-ai/glm-5.3` |
| `VISION_MODEL` | Reads photos. Default `moonshotai/kimi-k2.6` |
| `NANOGPT_API_URL`, `STT_MODEL` | Web search and voice transcription. Default `Whisper-Large-V3` |
| `MEALIE_URL`, `MEALIE_API_TOKEN` | Where the app reaches Mealie (an internal address is fine) |
| `MEALIE_PUBLIC_URL` | Mealie's public address, for recipe links |
| `CALENDAR_ICS_URLS` | Comma-separated ICS feeds. A Google Calendar "secret address in iCal format" works |
| `EVENING_START_HOUR`, `EVENING_END_HOUR` | An event overlapping this window marks the night busy. Default 17 to 20 |
| `TZ` | Household time zone |
| `SETUP_TOKEN` | If set, the setup page only works from `/setup?token=...`. Set it on any public deployment |
| `DATA_DIR` | Where SQLite and photos go. Default `./data` |

All-day events only block a night when they look like being away (trip, vacation, travel, camping). Add `#nocook` to any event title to block that evening on purpose.

### Picking a model

I ran the same planning conversation through a few models. GLM 5.3 did everything right: it put the meals on the ticket with linked recipes, marked busy nights off, saved the profile change, and placed the web find on the night asked for. Kimi K2.6 was faster but sometimes described a plan without writing it, and once leaked its tool call as raw text. The agent now parses that leak, but GLM is the default. GLM 5.3 doesn't take images, so photos go through a separate vision model first.

## Security notes

- Logins are per person with a 4-digit PIN. Five misses lock that person out, and each lockout doubles (5 minutes, 10, 20, up to a day). Lockouts survive restarts.
- Sessions are random tokens in an httpOnly cookie, valid for 180 days.
- The link reader refuses private and loopback addresses, so a pasted link or a search result can't make the server fetch things on your home network.
- Web pages and search results go to the model as reference material, and anything with side effects waits for a person to approve it.

## Repo layout

```
web/          the app (Next.js, TypeScript, SQLite)
assets/       icon, home-screen icons, banner (banner.html is the source)
docs/         architecture, chef persona, screenshots
prototype/    the original static UI mock
```

## License

MIT
