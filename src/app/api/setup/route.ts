import { NextRequest, NextResponse } from "next/server";
import { isSeeded, seedDemo } from "@/lib/setup";

export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const key = req.headers.get("x-setup-key");
  return !!key && key === process.env.AUTH_SECRET;
}

/**
 * POST /api/setup — one-click demo seeding.
 *
 * Hardening (Phase 2.6), demo/production separation:
 * - The demo deployment sets DEMO_MODE=1 and may be seeded freely — its
 *   database is isolated, resettable, and must NEVER hold a real school.
 * - Any other deployment (including production) requires the setup key
 *   (AUTH_SECRET, known only to the owner) even on an empty database.
 *   Previously an empty database could be seeded by anyone, which is how
 *   a public demo login could end up on a production database.
 * - The response NEVER returns demo logins or a password. Those live in
 *   the demo deployment's own documentation, not in an API response, and
 *   the platform super-admin login is never published at all.
 */
export async function POST(req: NextRequest) {
  try {
    const demoMode = process.env.DEMO_MODE === "1";
    const seeded = await isSeeded();
    if (!demoMode && !authed(req)) {
      return NextResponse.json(
        { error: "Setup requires the setup key. Send it as the x-setup-key header." },
        { status: 403 }
      );
    }
    if (seeded && !authed(req)) {
      return NextResponse.json(
        { seeded: true, message: "Database already has data. Provide the setup key to reset and reseed." },
        { status: 200 }
      );
    }
    await seedDemo();
    return NextResponse.json({
      seeded: true,
      message: "Database seeded with the Demo Academy demo data.",
    });
  } catch (e) {
    console.error("setup failed", e);
    return NextResponse.json(
      { error: "Setup failed. Please try again." },
      { status: 500 }
    );
  }
}
