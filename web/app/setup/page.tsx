import { redirect } from "next/navigation";
import SetupScreen from "@/components/SetupScreen";
import { listUsers } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Setup({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  if (listUsers().length) redirect("/login");
  const { token } = await searchParams;
  return <SetupScreen token={token ?? ""} />;
}
