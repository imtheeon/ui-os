"use client";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "../../src/lib/supabaseBrowser";

export default function LogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    await supabaseBrowser.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button onClick={handleLogout} style={styles.button}>
      Sign out
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    marginTop: "auto",
    background: "none",
    border: "1px solid #334155",
    color: "#94a3b8",
    borderRadius: 6,
    padding: "0.45rem 0.6rem",
    fontSize: "0.85rem",
    cursor: "pointer",
    textAlign: "left",
  },
};
