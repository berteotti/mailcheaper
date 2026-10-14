import { NextResponse } from "next/server";
import { getConfigProblems } from "@/lib/config";

// Read on every request: it reports the environment the server runs with, not the one it was built with.
export const dynamic = "force-dynamic";

// For uptime checks. A server set up in a way it refuses to run with (instrumentation.js) answers 503 and why.
export function GET() {
	const problems = getConfigProblems();
	return NextResponse.json(problems.length > 0 ? { ok: false, problems } : { ok: true }, {
		status: problems.length > 0 ? 503 : 200,
		headers: { "cache-control": "no-store" },
	});
}
