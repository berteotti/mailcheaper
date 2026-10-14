import requestModule from "next/dist/server/web/spec-extension/request.js";
import responseModule from "next/dist/server/web/spec-extension/response.js";

export const { NextRequest } = requestModule;
export const { NextResponse } = responseModule;

// after() runs once the response is sent; tests wait for that work with flushAfter().
const pending = [];

export function after(task) {
	pending.push(Promise.resolve().then(() => (typeof task === "function" ? task() : task)));
}

export async function flushAfter() {
	while (pending.length > 0) await Promise.allSettled(pending.splice(0));
}
