import { lessonBook, setLesson, teach } from "@/lib/mind";
import { isAdmin } from "@/lib/admin";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// MIND's lesson book (admin only): read it, switch lessons on or off, teach it.
export async function GET() {
  if (!isAdmin()) return fail("unauthorized", 401);
  return json({ lessons: await lessonBook() });
}

export async function POST(req: Request) {
  if (!isAdmin()) return fail("unauthorized", 401);
  try {
    const b = await req.json();
    if (b.action === "teach") {
      const text = String(b.text || "").trim();
      if (text.length < 20) return fail("paste at least a sentence");
      const added = await teach(text, String(b.src || "admin").slice(0, 40));
      return json({ ok: true, added });
    }
    if (b.action === "lesson") {
      const l = await setLesson(String(b.id || ""), { off: b.off, text: b.text });
      return l ? json({ ok: true, lesson: l }) : fail("no such lesson");
    }
    return fail("unknown action");
  } catch (e) {
    return fail(e);
  }
}
