# Architecture

## Pieces

| Piece | Where | Job |
|---|---|---|
| Pages | `web/app/` | Setup, PIN login, and the kitchen screen (chat, week ticket, profiles) |
| API routes | `web/app/api/` | Chat stream, week edits, send to Mealie, profiles, approvals, uploads, transcription |
| Agent loop | `web/lib/sal/agent.ts` | Streams the model's reply, runs the tools it asks for, loops until Sal answers in plain text |
| Prompt | `web/lib/sal/prompt.ts` | Persona, rules, today's date, the household's profiles, and the current week |
| Tools | `web/lib/sal/tools.ts` | Tool schemas, what each one does, and the approval flow |
| Mealie client | `web/lib/mealie.ts` | Thin wrapper over the Mealie REST API |
| Calendar | `web/lib/calendar.ts` | Reads ICS feeds, expands repeating events, finds busy evenings |
| Week | `web/lib/week.ts` | The week ticket: nights, overrides, sending to Mealie |
| Web | `web/lib/web.ts` | Web search and the link reader (with private-address blocking) |
| Vision | `web/lib/vision.ts` | Describes photos for the chat model |
| Storage | `web/lib/db.ts` | SQLite schema and profile helpers |

## Tools Sal can call

| Tool | What it does | Needs approval |
|---|---|---|
| `search_recipes(query)` | Search the Mealie recipe box | No |
| `get_recipe(slug)` | Full recipe: ingredients, steps, time | No |
| `recent_dinners(weeks)` | Dinners on Mealie's meal plan lately, to avoid repeats | No |
| `get_week(week_of)` | Any week's ticket: busy nights, overrides, planned dishes | No |
| `plan_nights(nights[])` | Write dishes onto the ticket, or mark nights off | No (it's a draft) |
| `web_search(query)` | Find new recipes online | No |
| `read_link(url)` | Read a page. Recipe pages come back as structured ingredients and steps | No |
| `import_recipe_url(url, plan_for?)` | Save a web recipe into Mealie, optionally onto a night | Yes |
| `update_profile(person, changes[])` | Add or remove likes, won't-eats, allergies, notes | Yes |

An approval-gated tool doesn't run. It records a pending action and tells the model it's waiting. The chat shows the action as a card with approve and decline buttons. Tapping one runs (or drops) the action and adds an event line to the conversation, so Sal knows what happened on his next turn.

Sending the week to Mealie isn't a tool at all. Only the "Send to Mealie" button on the ticket does it.

## Mealie endpoints used

| Action | Endpoint |
|---|---|
| Search recipes | `GET /api/recipes?search=...&perPage=...` |
| Get a recipe | `GET /api/recipes/{slug}` |
| Import by URL | `POST /api/recipes/create/url` (returns the new slug) |
| List meal plans | `GET /api/households/mealplans?start_date=...&end_date=...` |
| Create a dinner | `POST /api/households/mealplans` with `date`, `entryType: "dinner"`, and `recipeId` or `title` |
| Delete a dinner | `DELETE /api/households/mealplans/{id}` |

Auth is a long-lived API token, sent as `Authorization: Bearer <token>`. Checked against Mealie v3.29.

## Data model (SQLite)

```
users            id, name, role (adult | kid), color, pin_hash
sessions         token, user_id, expires_at
login_failures   user_id, count, locks, locked_until
profiles         user_id, loves[], nopes[], allergies[], notes[]
profile_log      user_id, by_user_id, change, source (chat | manual)
messages         user_id, role (user | assistant | tool | event | reset), content, payload
pending_actions  user_id, kind, args, summary, status
nights           date, cooking (null = follow calendar), title, recipe_slug, recipe_id, source_url, note, mealie_entry_id
uploads          id, user_id, mime   (files in DATA_DIR/uploads)
```

Each person has one running conversation with Sal. "Start a new conversation" adds a `reset` marker, and Sal only reads messages after the latest one. The model sees at most the last 60 entries.

The week is shared: there's one ticket for the household, and everyone sees the same nights.

## Cooking nights

1. Pull events for the week from every feed in `CALENDAR_ICS_URLS` (cached for 10 minutes).
2. A timed event overlapping 5 to 8 PM marks that evening busy. All-day events count only if they look like being away. `#nocook` in a title always counts.
3. Busy nights start as "no cooking". Anyone can flip a night either way, and that choice overrides the calendar.
4. Sal plans the cooking nights and tells you which ones he skipped.

## Deployment

One container next to Mealie. The app reaches Mealie over the cluster network (`MEALIE_URL`) and links people to Mealie's public address (`MEALIE_PUBLIC_URL`). It needs a small persistent volume for `/data` and a single replica, since SQLite is a single file.
