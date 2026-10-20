# Architecture

## Pieces

| Piece | Job |
|---|---|
| Web app | Chat UI, taste profiles, week view. Streams Sal's replies |
| Agent loop | Sends the conversation and tool definitions to the LLM, runs the tools it asks for, loops until Sal has a reply |
| Mealie client | Thin wrapper over the Mealie REST API |
| Calendar client | Reads the shared family calendar for the week |
| SQLite | Users, profiles, conversations, pending week plans |
| Media handling | Voice notes go to speech-to-text. Photos go to a vision-capable model |

## Tools Sal can call

| Tool | What it does | Needs approval |
|---|---|---|
| `search_recipes(query, tags?)` | Search the Mealie recipe box | No |
| `get_recipe(slug)` | Full recipe: ingredients, steps, time | No |
| `read_calendar(start, end)` | Events for the week, used to mark nights off | No |
| `web_search(query)` | Find new recipes online | No |
| `fetch_url(url)` | Read a page someone pasted | No |
| `propose_week(days[])` | Show a draft plan in the week view | No |
| `write_meal_plan(days[])` | Create Mealie meal plan entries | Yes |
| `import_recipe_url(url)` | Add a web recipe to Mealie | Yes |
| `update_profile(user, change)` | Add or remove a like, dislike, or note | Yes |

"Needs approval" means the app shows a confirm button and the tool runs only after a person taps it. The model can't get around this, because the app holds the call until then.

## Mealie endpoints

Mealie's API docs are served by every instance at `/docs`. The endpoints below are the ones Sal needs. Check them against the running version before building.

| Action | Endpoint |
|---|---|
| Search recipes | `GET /api/recipes?search=...&perPage=...` |
| Get a recipe | `GET /api/recipes/{slug}` |
| Import by URL | `POST /api/recipes/create/url` |
| List meal plans | `GET /api/households/mealplans?start_date=...&end_date=...` |
| Create a meal plan entry | `POST /api/households/mealplans` with `date`, `entryType`, `recipeId` or `title` |
| Shopping lists | `/api/households/shopping/lists` |

Auth is a long-lived API token created in Mealie under the user profile, sent as `Authorization: Bearer <token>`.

## Data model (SQLite)

```
users          id, name, role (adult | kid), avatar_color, login
profiles       user_id, loves[], nopes[], allergies[], notes[], updated_at
profile_log    id, user_id, change, source (chat | manual), created_at
conversations  id, user_id, started_at
messages       id, conversation_id, role, content, attachments[], created_at
week_plans     id, week_start, status (draft | sent), days[] (json)
```

Profiles are readable by everyone in the household. Adults edit their own profile and the kid's. `profile_log` keeps a history so a bad guess from Sal can be undone.

## Deciding which nights are cooking nights

1. Pull the week's events from the shared calendar.
2. Mark an evening as off if an event overlaps 5 to 8 PM, or if it's tagged as an all-day trip.
3. Sal proposes meals for the rest and says which nights he skipped and why.
4. Anyone can flip a night on or off in the week view.

## Deployment

One container on the same home cluster as Mealie. The app reaches Mealie over the internal service address, so the API token never crosses the internet. The app sits behind the same reverse proxy as everything else, with its own login.
