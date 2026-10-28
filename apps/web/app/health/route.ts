/**
 * Liveness for the deploy gate (spec 17 3.2): the web probe calls GET /health on the candidate tag URL. It answers
 * 200 without touching the database or anything else, so it only shows the server is up. IAP still sits in front.
 */
export function GET() {
  return Response.json({ ok: true });
}
