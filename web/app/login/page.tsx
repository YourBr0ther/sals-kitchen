import { redirect } from "next/navigation";
import LoginScreen from "@/components/LoginScreen";
import { currentUser } from "@/lib/auth";
import { listUsers } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Login() {
  const users = listUsers();
  if (!users.length) redirect("/setup");
  if (await currentUser()) redirect("/");
  return <LoginScreen people={users.filter((u) => u.hasPin)} />;
}
