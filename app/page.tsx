import { redirect } from "next/navigation";
import { supabaseServer } from "../src/lib/supabaseServer";

export default async function HomePage() {
  const supabase = await supabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session) redirect("/dashboard");
  redirect("/login");
}
