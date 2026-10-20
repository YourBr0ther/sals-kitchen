import { currentUser, unauthorized } from "@/lib/auth";
import { addMemory, deleteMemory, listMemories } from "@/lib/memory";
import { guarded, readJson } from "@/lib/http";

/** Your own memories only; nobody can read or change anyone else's. */
export const GET = guarded("memories GET", async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json({ memories: listMemories(user.id) });
});

export const POST = guarded("memories POST", async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const body = await readJson<{ text?: string }>(req);
  if (!body.ok) return body.response;
  if (!addMemory(user.id, String(body.data.text ?? ""), "manual")) {
    return Response.json({ error: "Sal already knows that, or it's too short." }, { status: 400 });
  }
  return Response.json({ memories: listMemories(user.id) });
});

export const DELETE = guarded("memories DELETE", async function DELETE(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!id || !deleteMemory(user.id, id)) return Response.json({ error: "That memory is already gone." }, { status: 404 });
  return Response.json({ memories: listMemories(user.id) });
});
