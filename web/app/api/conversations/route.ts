import type { NextRequest } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { pastConversations } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { guarded } from "@/lib/http";

/** This person's earlier conversations, optionally only ones that mention `q`. Nobody else's. */
export const GET = guarded("conversations GET", async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return unauthorized();
  let conversations = pastConversations(user.id, 1000);
  const q = req.nextUrl.searchParams.get("q")?.trim().slice(0, 60);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const hits = (
      getDb()
        // the words people and Sal said, plus photo descriptions; not the payload's keys
        .prepare(
          `select id from messages where user_id = ? and role in ('user', 'assistant') and payload not like '%"tool_calls"%' and (
             content like ? escape '\\' or json_extract(payload, '$.display') like ? escape '\\'
             or json_extract(payload, '$.photoNotes') like ? escape '\\')`,
        )
        .all(user.id, like, like, like) as { id: number }[]
    ).map((r) => r.id);
    conversations = conversations.filter((c) => hits.some((id) => id > c.after && id <= c.through));
  }
  return Response.json({ conversations: conversations.slice(0, 60) });
});
