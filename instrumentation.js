import { getConfigProblems } from "./lib/config.js";

// Runs once when a server starts, before it takes requests. Builds skip it, so they need no secrets.
export function register() {
	const problems = getConfigProblems();
	if (problems.length > 0) throw new Error(`MailCheap can't start. ${problems.join(" ")}`);
}
