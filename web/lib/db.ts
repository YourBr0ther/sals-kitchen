import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

export type Role = "adult" | "kid";

export interface User {
  id: number;
  name: string;
  role: Role;
  color: string;
  hasPin: boolean;
}

export interface Profile {
  userId: number;
  loves: string[];
  nopes: string[];
  allergies: string[];
  notes: string[];
  updatedAt: string;
}

const SCHEMA = `
create table if not exists users (
  id integer primary key,
  name text not null unique collate nocase,
  role text not null check (role in ('adult', 'kid')),
  color text not null,
  pin_hash text,
  created_at text not null default (datetime('now'))
);
create table if not exists sessions (
  token text primary key,
  user_id integer not null references users(id) on delete cascade,
  expires_at text not null
);
create table if not exists profiles (
  user_id integer primary key references users(id) on delete cascade,
  loves text not null default '[]',
  nopes text not null default '[]',
  allergies text not null default '[]',
  notes text not null default '[]',
  updated_at text not null default (datetime('now'))
);
create table if not exists profile_log (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  by_user_id integer references users(id) on delete set null,
  change text not null,
  source text not null check (source in ('chat', 'manual')),
  created_at text not null default (datetime('now'))
);
create table if not exists messages (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool', 'event', 'reset')),
  content text not null default '',
  payload text not null default '{}',
  created_at text not null default (datetime('now'))
);
create index if not exists messages_user on messages(user_id, id);
create table if not exists pending_actions (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  kind text not null,
  args text not null,
  summary text not null,
  status text not null default 'pending',
  result text,
  created_at text not null default (datetime('now'))
);
create table if not exists nights (
  date text primary key,
  cooking integer,
  title text,
  recipe_slug text,
  recipe_id text,
  source_url text,
  note text,
  mealie_entry_id text,
  updated_by integer references users(id) on delete set null,
  updated_at text not null default (datetime('now'))
);
create table if not exists login_failures (
  user_id integer primary key references users(id) on delete cascade,
  count integer not null default 0,
  locks integer not null default 0,
  locked_until integer not null default 0
);
create table if not exists memories (
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  text text not null,
  source text not null check (source in ('chat', 'summary', 'manual')),
  created_at text not null default (datetime('now'))
);
create index if not exists memories_user on memories(user_id, id);
create table if not exists conversation_state (
  user_id integer primary key references users(id) on delete cascade,
  summary text not null default '',
  summarized_through integer not null default 0,
  updated_at text not null default (datetime('now'))
);
create table if not exists uploads (
  id text primary key,
  user_id integer not null references users(id) on delete cascade,
  mime text not null,
  created_at text not null default (datetime('now'))
);
`;

/** Columns and constraints added after the first deploy. Each step is safe to run again. */
function migrate(d: Database.Database) {
  const cols = (table: string) => (d.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols("nights").includes("sent_signature")) {
    d.exec("alter table nights add column sent_signature text");
    // nights sent before this column existed match whatever they hold now
    d.exec(`update nights set sent_signature = json_array(coalesce(title, ''), coalesce(recipe_id, ''), coalesce(source_url, ''), coalesce(note, ''))
            where mealie_entry_id is not null`);
  }
  // the first schema limited action statuses with a check; 'running' needs the table rebuilt without it
  const ddl = (d.prepare("select sql from sqlite_master where name = 'pending_actions'").get() as { sql: string }).sql;
  if (ddl.includes("check (status in")) {
    d.transaction(() => {
      d.exec(`create table pending_actions_new (
        id integer primary key,
        user_id integer not null references users(id) on delete cascade,
        kind text not null,
        args text not null,
        summary text not null,
        status text not null default 'pending',
        result text,
        created_at text not null default (datetime('now'))
      )`);
      d.exec("insert into pending_actions_new select id, user_id, kind, args, summary, status, result, created_at from pending_actions");
      d.exec("drop table pending_actions");
      d.exec("alter table pending_actions_new rename to pending_actions");
    })();
  }
  // a crash mid-action leaves it 'running'; it may have half-happened, so don't offer it again blindly
  d.exec("update pending_actions set status = 'failed', result = 'Interrupted by a restart. Ask Sal to try again.' where status = 'running'");
}

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new Database(path.join(config.dataDir, "sal.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  // checkpoint the WAL and close cleanly when the pod is stopped
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      try {
        db?.close();
      } finally {
        process.exit(0);
      }
    });
  }
  return db;
}

type UserRow = { id: number; name: string; role: Role; color: string; pin_hash: string | null };

const toUser = (r: UserRow): User => ({
  id: r.id,
  name: r.name,
  role: r.role,
  color: r.color,
  hasPin: Boolean(r.pin_hash),
});

export function listUsers(): User[] {
  return (getDb().prepare("select * from users order by role, id").all() as UserRow[]).map(toUser);
}

export function getUser(id: number): User | undefined {
  const r = getDb().prepare("select * from users where id = ?").get(id) as UserRow | undefined;
  return r && toUser(r);
}

export function getUserByName(name: string): User | undefined {
  const r = getDb().prepare("select * from users where name = ?").get(name) as UserRow | undefined;
  return r && toUser(r);
}

export function getPinHash(id: number): string | null {
  const r = getDb().prepare("select pin_hash from users where id = ?").get(id) as { pin_hash: string | null } | undefined;
  return r?.pin_hash ?? null;
}

type ProfileRow = { user_id: number; loves: string; nopes: string; allergies: string; notes: string; updated_at: string };

export function getProfile(userId: number): Profile {
  const r = getDb().prepare("select * from profiles where user_id = ?").get(userId) as ProfileRow | undefined;
  if (!r) return { userId, loves: [], nopes: [], allergies: [], notes: [], updatedAt: "" };
  return {
    userId,
    loves: JSON.parse(r.loves),
    nopes: JSON.parse(r.nopes),
    allergies: JSON.parse(r.allergies),
    notes: JSON.parse(r.notes),
    updatedAt: r.updated_at,
  };
}

export const PROFILE_LISTS = ["loves", "nopes", "allergies", "notes"] as const;
export type ProfileList = (typeof PROFILE_LISTS)[number];

export interface ProfileChange {
  add?: Partial<Record<ProfileList, string[]>>;
  remove?: Partial<Record<ProfileList, string[]>>;
}

export function applyProfileChange(userId: number, change: ProfileChange, byUserId: number, source: "chat" | "manual"): Profile {
  const p = getProfile(userId);
  const norm = (s: string) => s.trim().toLowerCase();
  for (const list of PROFILE_LISTS) {
    const removals = new Set((change.remove?.[list] ?? []).map(norm));
    let items = p[list].filter((x) => !removals.has(norm(x)));
    for (const add of change.add?.[list] ?? []) {
      const t = add.trim();
      if (t && !items.some((x) => norm(x) === norm(t))) items = [...items, t];
    }
    p[list] = items;
  }
  const d = getDb();
  d.prepare(
    `insert into profiles (user_id, loves, nopes, allergies, notes, updated_at)
     values (@userId, @loves, @nopes, @allergies, @notes, datetime('now'))
     on conflict(user_id) do update set loves = excluded.loves, nopes = excluded.nopes,
       allergies = excluded.allergies, notes = excluded.notes, updated_at = excluded.updated_at`,
  ).run({
    userId,
    loves: JSON.stringify(p.loves),
    nopes: JSON.stringify(p.nopes),
    allergies: JSON.stringify(p.allergies),
    notes: JSON.stringify(p.notes),
  });
  d.prepare("insert into profile_log (user_id, by_user_id, change, source) values (?, ?, ?, ?)").run(
    userId,
    byUserId,
    JSON.stringify(change),
    source,
  );
  return getProfile(userId);
}

/** Adults can edit their own profile and the kids'. Kids can't log in, so they never edit. */
export function canEditProfile(editor: User, target: User): boolean {
  return editor.role === "adult" && (editor.id === target.id || target.role === "kid");
}
