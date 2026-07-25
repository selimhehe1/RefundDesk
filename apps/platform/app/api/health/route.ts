export const runtime = "nodejs";

export function GET(): Response {
  return Response.json(
    { status: "ok", service: "platform" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
