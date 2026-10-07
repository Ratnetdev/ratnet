"use client";
import { useEffect, useState } from "react";

let once: Promise<boolean> | null = null;

/** True when this browser is signed in to admin (checked once per page load). */
export function useAdmin() {
  const [a, setA] = useState(false);
  useEffect(() => {
    once ||= fetch("/api/admin/me", { cache: "no-store" }).then((r) => r.json()).then((j) => !!j.admin).catch(() => false);
    once.then(setA);
  }, []);
  return a;
}

/** Add ?full=1 for an admin, so the API returns the agents' knowledge base too. */
export function fullUrl(url: string, admin: boolean) {
  return admin ? `${url}${url.includes("?") ? "&" : "?"}full=1` : url;
}
