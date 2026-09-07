import { NextResponse } from "next/server";
import { accountOwnsSession, getCurrentAccountUid } from "@/lib/accounts";
import {
  deleteMessageFeedback,
  listMessageFeedback,
  saveMessageFeedback,
  type MessageFeedbackInput,
} from "@/lib/message-feedback";

export const dynamic = "force-dynamic";

async function authorizeSession(sessionId: unknown): Promise<{ uid: string } | { response: NextResponse }> {
  const uid = await getCurrentAccountUid();
  if (!uid) return { response: NextResponse.json({ error: "Not logged in" }, { status: 401 }) };
  if (typeof sessionId !== "string" || !accountOwnsSession(uid, sessionId)) {
    return { response: NextResponse.json({ error: "Session not found" }, { status: 404 }) };
  }
  return { uid };
}

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    const authorization = await authorizeSession(sessionId);
    if ("response" in authorization) return authorization.response;
    return NextResponse.json({ feedback: listMessageFeedback(authorization.uid, sessionId!) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as {
      sessionId?: unknown;
      entryId?: unknown;
      feedback?: MessageFeedbackInput | null;
    };
    const authorization = await authorizeSession(body.sessionId);
    if ("response" in authorization) return authorization.response;
    if (typeof body.entryId !== "string") {
      return NextResponse.json({ error: "Invalid entry ID" }, { status: 400 });
    }
    if (body.feedback === null) {
      deleteMessageFeedback(authorization.uid, body.sessionId as string, body.entryId);
      return NextResponse.json({ feedback: null });
    }
    if (!body.feedback || typeof body.feedback !== "object" || Array.isArray(body.feedback)) {
      return NextResponse.json({ error: "Invalid feedback" }, { status: 400 });
    }
    const feedback = saveMessageFeedback(
      authorization.uid,
      body.sessionId as string,
      body.entryId,
      body.feedback,
    );
    return NextResponse.json({ feedback });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
