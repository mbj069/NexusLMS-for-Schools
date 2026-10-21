"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface Me {
  name: string;
  email: string;
  role: string;
  schoolName: string | null;
}

const NAV: Record<string, { href: string; label: string }[]> = {
  SUPER_ADMIN: [{ href: "/platform", label: "Schools" }],
  SCHOOL_ADMIN: [
    { href: "/dashboard", label: "Overview" },
    { href: "/dashboard/users", label: "Users" },
    { href: "/dashboard/structure", label: "Classes & Subjects" },
    { href: "/dashboard/timetable", label: "Timetable" },
    { href: "/dashboard/attendance", label: "Attendance" },
  ],
  TEACHER: [
    { href: "/dashboard", label: "My Classes" },
    { href: "/dashboard/timetable", label: "Timetable" },
    { href: "/dashboard/attendance", label: "Attendance" },
  ],
  STUDENT: [
    { href: "/dashboard", label: "My Learning" },
    { href: "/dashboard/timetable", label: "Timetable" },
    { href: "/dashboard/attendance", label: "Attendance" },
  ],
  PARENT: [
    { href: "/dashboard", label: "My Children" },
    { href: "/dashboard/timetable", label: "Timetable" },
    { href: "/dashboard/attendance", label: "Attendance" },
  ],
};

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: "Platform Admin",
  SCHOOL_ADMIN: "School Admin",
  TEACHER: "Teacher",
  STUDENT: "Student",
  PARENT: "Parent",
};

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => {});
  }, []);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const links = me ? NAV[me.role] ?? [] : [];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-700 font-bold text-white">
              N
            </div>
            <div>
              <div className="font-semibold leading-tight">NexusLMS</div>
              {me?.schoolName && (
                <div className="text-xs text-slate-500">{me.schoolName}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {me && (
              <>
                <span className="hidden text-slate-500 sm:inline">
                  {me.name} · {ROLE_LABEL[me.role] ?? me.role}
                </span>
                <button
                  onClick={signOut}
                  className="rounded-md border px-3 py-1.5 text-slate-600 hover:bg-slate-100"
                >
                  Sign out
                </button>
              </>
            )}
          </div>
        </div>
        {links.length > 0 && (
          <nav className="mx-auto flex max-w-6xl gap-1 px-4 pb-2">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  pathname === l.href
                    ? "bg-blue-50 font-medium text-blue-700"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
