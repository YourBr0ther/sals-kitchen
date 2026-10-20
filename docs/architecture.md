# Architecture

## Pieces

| Piece | Where | Job |
|---|---|---|
| Pages | `web/app/` | Setup, PIN login, and the kitchen screen (chat, week ticket, profiles, settings, earlier conversations) |
| API routes | `web/app/api/` | Chat stream and stop, week edits, send to Mealie, grocery list, profiles, approvals, uploads, transcription, read-aloud, feedback, kitchen list, household log, reminders, settings |
| Agent loop | `web/lib/sal/agent.ts` | Streams the model's reply, runs the tools it asks for, loops until Sal answers in plain text |
| Prompt | `web/lib/sal/prompt.ts` | Persona, rules, today's date, the household's profiles, and the current week |
| Tools | `web/lib/sal/tools.ts` | Tool schemas, what each one does, and the approval flow |
| Mealie client | `web/lib/mealie.ts` | Thin wrapper over the Mealie REST API |
| Calendar | `web/lib/calendar.ts` | Reads ICS feeds, expands repeating events, finds busy evenings |
| Week | `web/lib/week.ts` | The week ticket: nights, overrides, sending to Mealie |
| Web | `web/lib/web.ts` | Web search, the public-only page fetcher, photo downloads |
| Recipes | `web/lib/recipe.ts` | Turns a web page into a recipe, for both the link reader and the Mealie import |
| Vision | `web/lib/vision.ts` | Describes photos for the chat model, and copies out recipes word for word |
| Tagger | `web/lib/tagger.ts` | Picks tags and categories for a saved recipe, reusing the box's own |
| Groceries | `web/lib/groceries.ts` | Builds the week's grocery list and writes it to Mealie |
| Feedback | `web/lib/feedback.ts` | How dinners went: asks, saves, and updates Mealie |
| Kitchen list, log | `web/lib/pantry.ts`, `web/lib/activity.ts` | What's on hand, and what everyone has been doing |
| Reminders | `web/lib/push.ts`, `web/lib/reminders.ts`, `web/instrumentation.ts` | Web push, and the once-a-minute scheduler that decides what to send |
| Recipe card | `web/components/RecipeSheet.tsx`, `web/lib/scale.ts` | The in-app recipe view with servings, checklists, and timers |
| Memory | `web/lib/memory.ts` | Conversation window, rolling summaries, and each person's private memories |
| Storage | `web/lib/db.ts` | SQLite schema, migrations, and profile helpers |
| PWA | `web/public/sw.js`, `web/app/manifest.ts`, `web/components/Pwa.tsx` | Service worker, manifest, install prompt |

## Tools Sal can call

| Tool | What it does | Needs approval |
|---|---|---|
| `search_recipes(query)` | Search the Mealie recipe box | No |
| `get_recipe(slug)` | Full recipe: ingredients, steps, time | No |
| `recent_dinners(weeks)` | Dinners on Mealie's meal plan lately, to avoid repeats | No |
| `get_week(week_of)` | Any week's ticket: busy nights, overrides, planned dishes | No |
| `plan_nights(nights[])` | Write dishes onto the ticket, or mark nights off | No (it's a draft) |
| `web_search(query)` | Find new recipes online | No |
| `read_link(url)` | Read a page. Recipes come back as ingredients and steps with `importable: true` | No |
| `import_recipe_url(url, plan_for?)` | Save a web recipe into Mealie, optionally onto a night. Refused up front if the page has no recipe | Yes |
| `save_recipe_from_chat(title?, plan_for?)` | Save a recipe from the person's latest photo or long pasted message | Yes |
| `make_grocery_list(week_of?)` | Write the week's grocery list into Mealie | Yes |
| `get_grocery_list(week_of?)` | Read what's left to buy and what's checked off | No |
| `update_pantry(add[], remove[])` | Change the shared kitchen list | Only while web text is in the conversation |
| `log_dinner(date, verdict, comment?)` | Save how a dinner went for the person talking | Only while web text is in the conversation |
| `update_profile(person, changes[])` | Add or remove likes, won't-eats, allergies, notes | Yes |
| `remember(fact)` | Save a private fact about the person talking (schedule, goals, equipment) | Only while web text is in the conversation |
| `forget(about)` | Remove a memory the person says is wrong | Only while web text is in the conversation |

An approval-gated tool doesn't run. It records a pending action and tells the model it's waiting. The chat shows the action as a card with approve and decline buttons. Tapping one runs (or drops) the action and adds an event line to the conversation, so Sal knows what happened on his next turn.

Sending the week to Mealie isn't a tool at all. Only the "Send to Mealie" button on the ticket does it.

"Web text in the conversation" means any tool result since the last new conversation that could carry text from the web: search results, pages, and recipes or plans from Mealie (recipes are often imported from the web). While that's true, tools that write on the person's behalf ask first, so a page can't steer Sal into saving a memory or rating a recipe.

## Grocery lists

`buildGroceryList(week)` in `web/lib/groceries.ts`:

1. Collect the cooking nights from today to the end of that week. Recipes in the box come from Mealie; web recipes on the ticket are read with `extractRecipe`. Free-text dinners with no recipe are reported as missing.
2. One model call writes the list. It gets each recipe's servings and the night's note, the number of people eating (`HOUSEHOLD_SIZE`, or the household's size), the kitchen list, and a short list of staples to leave off. It scales, combines, rounds to buyable amounts, and puts each item in one of eight aisles.
3. The list goes to Mealie as one shopping list per week, with each aisle as a Mealie label (created the first time). Items are plain notes, since Mealie's ingredient parser drops alternatives and invents foods.
4. Making it again deletes the unchecked items this app wrote before, keeps checked ones, skips new items that match something already checked, and leaves anything people added by hand. Builds run one at a time.

## After dinner

From the evening of a planned dinner until four days later, the chat shows each person a "How was it?" card for the most recent dinner they haven't answered. Answers are one per person per night.

- Loved it, fine, and not again count as cooked. The first one sets the recipe's last-made date in Mealie, the recipe's rating becomes the family's average (5, 3, and 1 stars), and each answer adds a comment to the recipe's timeline.
- Didn't make it is saved but doesn't touch Mealie. The card's close button is "don't ask about this one".
- The answer is saved locally first. If Mealie is down, the person sees that the answer was kept but Mealie didn't take it.
- An event line tells Sal, and the app asks him to answer, so he can react and offer to update a profile.

## Reading recipes from the web

`extractRecipe(url)` in `web/lib/recipe.ts` is the one path from a web page to a recipe. Sal's link reader and the Mealie import both use it, so what Sal read is what gets saved. The extracted recipe is stored with the approval request, and approving saves exactly that.

1. Fetch the page through the public-only connection. If the site blocks bots (Allrecipes, Serious Eats and Simply Recipes answer 402), fetch it through NanoGPT's page fetcher instead. That runs on their servers, and it's only used after the site has answered, never for addresses the app refused.
2. Look for a schema.org `Recipe` in the page's JSON-LD, at any depth (`@graph`, `mainEntity`, and so on).
3. If there isn't one, find the recipe in the page text. That's either a recipe-card plugin's container, or the "Ingredients" heading followed by the most measurements (cups, tbsp, lb…), since blog posts say "ingredients" in their FAQs too. The chat model copies the recipe out as JSON and is told not to invent anything. A page needs an ingredient list and steps to count.
4. Results are cached for an hour.

Roundup posts ("10 easy dinners") and articles come back as not importable. Sal is told to pitch only importable recipes, and the import tool refuses anything else before an approve button appears.

To save a recipe, the app builds schema.org JSON with no media URLs and sends it to Mealie's `create/html-or-json`. It then sets the source link and uploads the photo, which it downloaded itself. Mealie never fetches a URL from the web, so a link can't point it at the home network. If a recipe from the same page is already in Mealie, the app links that one instead of saving a copy.

When an approved action fails, the chat asks Sal to follow up straight away, so the person sees what went wrong and what to do next.

## Mealie endpoints used

| Action | Endpoint |
|---|---|
| Search recipes | `GET /api/recipes?search=...&perPage=...` |
| Get a recipe | `GET /api/recipes/{slug}` |
| Find by source page | `GET /api/recipes?queryFilter=orgURL = "..."` |
| Save a recipe | `POST /api/recipes/create/html-or-json` with schema.org JSON (returns the new slug) |
| Set source link | `PATCH /api/recipes/{slug}` with `orgURL` |
| Upload photo | `PUT /api/recipes/{slug}/image` (multipart `image`, `extension`) |
| List meal plans | `GET /api/households/mealplans?start_date=...&end_date=...` |
| Create a dinner | `POST /api/households/mealplans` with `date`, `entryType: "dinner"`, and `recipeId` or `title` |
| Delete a dinner | `DELETE /api/households/mealplans/{id}` |
| Tags and categories | `GET`/`POST /api/organizers/tags`, `/api/organizers/categories`, then `PATCH /api/recipes/{slug}` |
| Shopping list | `POST /api/households/shopping/lists`, `GET /api/households/shopping/lists/{id}` |
| List items | `POST /api/households/shopping/items/create-bulk`, `DELETE /api/households/shopping/items?ids=...` |
| Aisle labels | `GET`/`POST /api/groups/labels` |
| Last made | `PATCH /api/recipes/{slug}/last-made` (Mealie keeps it per household) |
| Rating | `POST /api/users/{id}/ratings/{slug}` for the token's user |
| Timeline note | `POST /api/recipes/timeline/events` |
| Check an item | `GET` then `PUT /api/households/shopping/items/{id}` with `checked` (only items on a list this app made) |
| Recipe photo | `GET /api/media/recipes/{id}/images/min-original.webp`, passed through `/api/recipes/{slug}/image` |

Auth is a long-lived API token, sent as `Authorization: Bearer <token>`. Checked against Mealie v3.29.

## Data model (SQLite)

```
users            id, name, role (adult | kid), color, pin_hash
sessions         token, user_id, expires_at
login_failures   user_id, count, locks, locked_until
memories         user_id, text, source (chat | summary | manual)
conversation_state  user_id, summary, summarized_through
profiles         user_id, loves[], nopes[], allergies[], notes[]
profile_log      user_id, by_user_id, change, source (chat | manual)
messages         user_id, role (user | assistant | tool | event | reset), content, payload
pending_actions  user_id, kind, args, summary, status (pending | running | approved | declined | failed)
nights           date, cooking (null = follow calendar), title, recipe_slug, recipe_id, source_url, note, mealie_entry_id, sent_signature
uploads          id, user_id, mime   (files in DATA_DIR/uploads)
pantry           item, added_by   (shared)
feedback         date, user_id, verdict (loved | fine | not_again | skipped | dismissed), comment
activity         user_id, text   (shared household log, last 500)
grocery_lists    week_start, list_id, item_ids[], item_count
push_subscriptions  endpoint, user_id, keys
user_settings    user_id, settings (reminders, read-aloud)
notifications_sent  user_id, kind, day   (one row per reminder, so none is sent twice)
```

`nights` also has `marked_made`, so Mealie's last-made date is set once per night. Spoken replies are cached as files in `DATA_DIR/tts`.

Each person has one running conversation with Sal. "Start a new conversation" adds a `reset` marker, and Sal only reads messages after the latest one. The chat screen shows the same range; earlier conversations are listed by where they end, can be searched by any word in them, and are only served to their owner. See Memory above for how much of it the model sees.

The week is shared: there's one ticket for the household, and everyone sees the same nights.

## Memory

Each person's memory with Sal is separate. Nothing from one person's chats or memories goes into another person's conversation. Taste profiles are the one shared thing, by design.

- **Conversation window.** The model sees this person's messages since the last "new conversation" and since the last summary. They go in newest first until about 30,000 characters. Tool results from the last two exchanges are kept long (6,000 characters each). Older ones are cut to 400, since a recipe page from three turns ago is mostly noise. A tool call is only sent along with all of its results, so an interrupted turn can't break later ones.
- **Rolling summary.** After a turn, if the window passes about 36,000 characters, the oldest part is summarized in the background. That covers decisions, plans, open questions, and recipes with links. The summary goes into the system prompt and the folded messages leave the window.
- **Memories.** These are short facts about the person that outlive conversations: schedule, goals, kitchen equipment, routines. Sal saves them with `remember`, and the summarizer pulls out new ones too. They're capped at 80 per person, and the automatic ones are dropped first. People see theirs on the Profiles screen and can add or delete them there.
- **New conversation.** The old conversation's facts are saved to memory, then the window and summary start fresh.

## Errors

- **API routes:** every route is wrapped so an unexpected error is logged and returns JSON the app can show. Request bodies are parsed safely and get a 400 if they're garbled.
- **Chat turns:** each turn has a 4-minute deadline and the AI calls have their own timeouts and retries. Failures become plain messages, and the ones that might clear up get a "Try again" button. The server sends a keepalive every 15 seconds so phones and proxies don't drop a quiet stream.
- **Dropped connections:** if the app loses the stream (backgrounded, lost signal), it asks the server whether Sal is still working and polls until his reply is saved. A message that never reached the server is taken back and the draft restored.
- **Approvals:** claimed atomically, so a double tap or a second phone can't run one twice. A request that's already been handled sends back its current state.
- **Week sends:** run one at a time. If one fails partway, the ticket reloads to show what went through.
- **Stop:** the Stop button aborts the turn on the server. Whatever Sal had said is saved with a trailing "…", and tools that already ran stay saved.
- **Read-aloud:** audio streams from NanoGPT straight to the phone and is kept on disk once complete. If Sal's voice fails, the phone's built-in voice reads the reply instead.
- **Saved recipes:** tagging runs after the save and can't undo it; a tagging failure is only logged.

## PWA

- **Install:** the manifest has standalone display, portrait orientation, regular and maskable icons, and shortcuts for Chat and This week (`/?tab=week`). Apple's meta tags make the iPhone home-screen app open full screen.
- **Service worker** (`public/sw.js`): pages always load from the network, with `offline.html` when there's none. Build assets, icons, and fonts are cached, since their URLs change whenever they do. Under `/api`, only recipe cards and their photos are kept (network first, the last 60), since they're household recipes and a card should open in a kitchen with no signal. Chats, profiles, memories, and everything else under `/api` are never cached, so no one's conversation is stored on the device.
- **Offline grocery list:** the checklist keeps its last copy of each week's list in the phone's local storage. Check-offs made offline wait in a queue there and go to Mealie one at a time, oldest first, when the connection is back. Opening the app with no signal at all shows the offline page, which reads the same copy and adds to the same queue; the app sends it the next time it opens online.
- **Slow signal:** a recipe card waits 4 seconds for the server, then shows the saved copy. A server error also falls back to it.
- **Timers:** cooking timers live in one app-wide store saved to local storage, so they outlast the recipe card and a reload. A timer that ran out while the app was closed shows as done without beeping.
- **Install prompt:** the menu offers "Add Sal to your home screen". Chrome and Android show their install prompt, and on iPhone a tap shows the Share → Add to Home Screen steps.
- **Offline:** an offline banner appears, and when the connection comes back the app reloads the chat, the week, and profiles.
- **Reminders:** the service worker shows pushed reminders and opens the app on the right tab when one is tapped. Endpoints are limited to the browsers' push services. iPhones only allow push for the home-screen app.
- **Dark mode:** colors are CSS variables with a dark set. It follows the phone, or the choice in Settings, applied before the first paint.

## Cooking nights

1. Pull events for the week from every feed in `CALENDAR_ICS_URLS`. Feeds are cached for 10 minutes, each fetch has a 15-second timeout, and a failed refresh keeps the last good copy. Repeats, moved instances, skipped dates, cancelled events, and "free" events are handled by node-ical's expansion.
2. A timed event overlapping 5 to 8 PM marks that evening busy. All-day events count only if they look like being away. `#nocook` in a title always counts.
3. Busy nights start as "no cooking". Anyone can flip a night either way, and that choice overrides the calendar.
4. Sal plans the cooking nights and tells you which ones he skipped.

## Deployment

One container next to Mealie. The app reaches Mealie over the cluster network (`MEALIE_URL`) and links people to Mealie's public address (`MEALIE_PUBLIC_URL`). It needs a small persistent volume for `/data` and a single replica, since SQLite is a single file and the reminder scheduler runs in the app process.
