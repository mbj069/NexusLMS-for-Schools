import { NextRequest, NextResponse } from "next/server";
import { isSeeded, seedDemo } from "@/lib/setup";

export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const key = req.headers.get("x-setup-key");
  return !!key && key === process.env.AUTH_SECRET;
}

export async function POST(req: NextRequest) {
  try {
    const seeded = await isSeeded();
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
      logins: [
        "superadmin@nexusms.app",
        "admin@demo.edu",
        "teacher@demo.edu",
        "student@demo.edu",
        "parent@demo.edu",
      ],
      password: "demo1234",
    });
  } catch (e) {
    console.error("setup failed", e);
    return NextResponse.json(
      { error: "Setup failed. Please try again." },
      { status: 500 }
    );
  }
}
