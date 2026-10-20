import { redirect } from "next/navigation";
import Kitchen from "@/components/Kitchen";
import { currentUser } from "@/lib/auth";
import { listUsers } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!listUsers().length) redirect("/setup");
  const me = await currentUser();
  if (!me) redirect("/login");
  return <Kitchen me={me} />;
}
