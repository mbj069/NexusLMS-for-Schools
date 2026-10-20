import Link from "next/link";

const FEATURES = [
  {
    title: "One workspace per school",
    body: "Each school gets its own isolated space — users, classes, and data never mix. Onboard a new school in minutes.",
  },
  {
    title: "Attendance in seconds",
    body: "Teachers mark attendance per class and period, with instant reports for admins and parents.",
  },
  {
    title: "Assignments & quizzes",
    body: "Create, distribute, collect, and grade — with auto-graded quizzes and a clean gradebook.",
  },
  {
    title: "Parents in the loop",
    body: "Parents see their child's attendance, grades, and announcements from a single view.",
  },
  {
    title: "Report cards",
    body: "Term-wise grades roll up into report cards automatically. No spreadsheets.",
  },
  {
    title: "Role-based access",
    body: "Platform admins, school admins, teachers, students, and parents — everyone sees exactly what they should.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-700 font-bold text-white">
              N
            </div>
            <span className="text-lg font-semibold">NexusLMS</span>
          </div>
          <Link
            href="/login"
            className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4">
        <section className="py-16 text-center sm:py-24">
          <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            The learning management system built for <span className="text-blue-700">every school</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
            Attendance, assignments, quizzes, grades, and parent updates — one
            platform, one workspace per school, zero spreadsheets.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link
              href="/login"
              className="rounded-lg bg-blue-700 px-6 py-3 font-medium text-white hover:bg-blue-800"
            >
              Sign in to your school
            </Link>
          </div>
        </section>

        <section className="grid gap-5 pb-20 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border bg-slate-50 p-5">
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-slate-600">{f.body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t py-6 text-center text-sm text-slate-500">
        NexusLMS · by Nexus-Tech Solutions
      </footer>
    </div>
  );
}
