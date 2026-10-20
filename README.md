<p align="center">
  <img src="assets/banner.png" alt="Sal's Kitchen" width="100%">
</p>

# Sal's Kitchen

Sal is a personal chef who lives in a chat window. He's an older guy, he's been cooking forever, and he's funny about it. You tell him what kind of week you're having. He checks the family calendar, works out which nights anyone can cook, and fills those nights with meals the household will eat. Then he sends the plan to [Mealie](https://mealie.io), the self-hosted recipe manager we already use.

The goal is simple. We want to cook at home more, and planning was always the part that killed it.

> **Status:** concept and UI prototype. The app isn't built yet. This repo explains what it is and what it should look like.

<p align="center">
  <img src="docs/screenshot.png" alt="Prototype: chat with Sal on the left, this week's meal plan as a kitchen ticket on the right" width="100%">
</p>

You can open the clickable prototype at [`prototype/index.html`](prototype/index.html). It has no backend. Sal's replies are canned, but switching users, editing your own taste profile, and pinning a recipe to Thursday all work.

## Built for phones first

Most planning happens on a phone: on the couch, or standing in the grocery store. The phone layout is the main one, and the desktop layout is the stretch.

<p align="center">
  <img src="docs/mobile.png" alt="Phone screens: chat with Sal, the week ticket, taste profiles, and the who's-cooking switcher" width="100%">
</p>

- A tab bar along the bottom (Chat, This week, Profiles), within thumb reach
- Your avatar sits top right. Tap it to switch who's talking
- The mic is the big button. It turns into send once you start typing
- The message box uses 16px text, so iOS doesn't zoom in when you tap it
- Every tap target is at least 44px
- The layout handles notches and home-bar insets, and the tab bar hides while the keyboard is up
- Add it to your home screen and it opens full screen, with its own icon, like an app

## What Sal does

**Plans the week.** Sal reads a shared calendar and treats busy evenings (practice, date night, travel) as nights off. A typical week ends up with four or five cooking nights, and he plans those.

**Starts with your recipe box.** Mealie is the source of truth for recipes. Sal searches it first, because a recipe you've already made once is the one you'll make again.

**Finds new things on the web.** When you ask for something new, or the box runs dry, Sal searches the web. He pitches one or two recipes, and with your OK he imports them into Mealie by URL.

**Learns what everyone likes.** Each person gets a taste profile: favorites, hard nos, allergies, and things Sal has noticed ("will eat broccoli if it's called a tree"). Sal builds it from conversation. Everyone can see everyone's profile, and you can only edit your own. A kid's profile is edited by the grown-ups.

**Writes the plan to Mealie.** When you approve the week, Sal creates Mealie meal plan entries for each cooking night. Shopping lists come from Mealie, so that part already works.

## Talking to him

Sal takes the inputs people expect from a chat app:

- Text
- Voice notes, transcribed and answered as text
- Links, which Sal reads (a recipe URL becomes a "want me to save this?")
- Photos, such as the inside of your fridge or a page from a cookbook

He talks like a guy who's run a kitchen for forty years and has stories about most of it. He's warm, he teases, and he keeps it short when you're standing in the grocery store. He never invents a recipe and claims it came from your box. The persona notes are in [`docs/chef-persona.md`](docs/chef-persona.md).

## How it fits together

```
 browser (phone or laptop)
        |
        v
 Sal's Kitchen web app ------> LLM provider (OpenAI-compatible API)
   |  chat, profiles,             tool calls: search_recipes, get_recipe,
   |  week planner                web_search, import_recipe_url,
   |                              read_calendar, write_meal_plan,
   |                              update_profile
   +--> Mealie REST API  (recipes, meal plans, shopping lists)
   +--> Calendar          (which nights are free)
   +--> SQLite            (users, profiles, chat history)
```

Sal is a tool-calling agent. The model decides when to search the recipe box, check the calendar, or update a profile. The app executes those tools against Mealie and the calendar. Nothing touches Mealie until a person approves the week.

More detail, including the data model and the Mealie endpoints, is in [`docs/architecture.md`](docs/architecture.md).

## Planned stack

| Piece | Choice | Why |
|---|---|---|
| Web app | Next.js (App Router), TypeScript | One codebase for UI and API routes, streams chat responses |
| LLM | Any OpenAI-compatible endpoint | Swap models without touching code |
| Storage | SQLite | One family, a few users. A database server would be overkill |
| Recipes | Mealie API with a long-lived API token | Mealie already holds the recipes and does shopping lists |
| Hosting | Container on a home Kubernetes cluster, next to Mealie | Talks to Mealie over the cluster network |
| Auth | One login per family member | Sal needs to know who he's talking to |

## Configuration

Copy `.env.example` to `.env` and fill it in. Never commit `.env`.

```
LLM_BASE_URL=https://example-provider/api/v1
LLM_API_KEY=
LLM_MODEL=
MEALIE_URL=http://mealie.internal:9000
MEALIE_API_TOKEN=
CALENDAR_ID=
```

## Roadmap

1. Chat with Sal (text only), backed by the recipe box in Mealie
2. Week planner: calendar in, meal plan out to Mealie
3. Taste profiles that Sal fills in from conversation
4. Web search and import-by-URL
5. Voice notes
6. Photos (fridge, cookbook pages)

## Repo layout

```
assets/       icon.svg, home-screen PNG icons, banner.png, banner.html (banner source)
docs/         architecture, chef persona, screenshots
prototype/    clickable static UI mock and web app manifest
```

## License

MIT
