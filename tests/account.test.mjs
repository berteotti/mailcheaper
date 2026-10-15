import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { execute } from "../lib/db.js";
import { activate, as, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";

// The account page's profile, and the account menu at the bottom of the sidebar.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GOOGLE_PICTURE = "https://lh3.googleusercontent.com/a/photo=s96-c";

let app;
let m;

async function uploadImage(user) {
	const request = new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { "content-type": "image/png", "x-file-name": "me" }, body: PNG });
	const response = await as(user, () => m.uploadsRoute.POST(request));
	assert.equal(response.status, 200);
	return (await response.json()).url;
}

function saveProfile(user, fields) {
	return as(user, () => m.account.updateProfile(null, form(fields)));
}

async function readUser(user) {
	return (await as(user, () => m.auth.requireAccount())).user;
}

before(async () => {
	app = await startTestApp();
	m = {
		account: await import("../app/(account)/account/actions.js"),
		uploadsRoute: await import("../app/api/uploads/route.js"),
		authRoute: await import("../app/api/auth/[...all]/route.js"),
		auth: await import("../lib/auth.js"),
		accounts: await import("../lib/accounts.js"),
		state: await import("../lib/account-state.js"),
		signOut: await import("../lib/sign-out.js"),
	};
});

after(() => app?.stop());

describe("the profile", () => {
	test("changes the name and photo through Better Auth, with a photo the account uploaded, and can drop the photo", async () => {
		const user = await signIn("profile@example.com");
		assert.deepEqual([(await readUser(user)).name, (await readUser(user)).image ?? null], ["", null], "a code sign-up starts without either");
		const url = await uploadImage(user);

		assert.deepEqual(await saveProfile(user, { name: "  Jane   Doe ", image: url }), { ok: true });
		const saved = await readUser(user);
		assert.deepEqual([saved.name, saved.image], ["Jane Doe", url]);

		assert.deepEqual(await saveProfile(user, { name: "Jane Doe", image: "" }), { ok: true });
		assert.equal((await readUser(user)).image, null);
	});

	test("refuses a photo from anywhere else, someone else's upload, or a name that's too long", async () => {
		const user = await signIn("careful@example.com");
		const someone = await signIn("someone@example.com");
		const theirs = await uploadImage(someone);

		assert.deepEqual(await saveProfile(user, { name: "Jo", image: "https://evil.example/pixel.png" }), { error: "Choose a photo you uploaded" });
		assert.deepEqual(await saveProfile(user, { name: "Jo", image: theirs }), { error: "Choose a photo you uploaded" });
		assert.deepEqual(await saveProfile(user, { name: "J".repeat(81) }), { error: "Keep your name under 80 characters" });
		const unchanged = await readUser(user);
		assert.deepEqual([unchanged.name, unchanged.image ?? null], ["", null]);
	});

	test("keeps the picture Google gave at sign-up, and says Google signs in too", async () => {
		const user = await signIn("google@example.com");
		await execute("UPDATE users SET name = ?, image = ? WHERE id = ?", ["Gina", GOOGLE_PICTURE, user.userId]);
		assert.equal(await m.accounts.hasGoogleSignIn(user.userId), false);
		const now = new Date().toISOString();
		await execute("INSERT INTO auth_accounts (id, userId, providerId, accountId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)", [
			"google-gina-sign-in",
			user.userId,
			"google",
			"google-gina",
			now,
			now,
		]);
		assert.equal(await m.accounts.hasGoogleSignIn(user.userId), true);

		assert.deepEqual(await saveProfile(user, { name: "Gina Lee", image: GOOGLE_PICTURE }), { ok: true });
		const saved = await readUser(user);
		assert.deepEqual([saved.name, saved.image], ["Gina Lee", GOOGLE_PICTURE]);
	});

	test("can't be changed through Better Auth's own route, so its checks can't be skipped", async () => {
		const user = await signIn("direct@example.com");
		const request = new Request("http://localhost:3000/api/auth/update-user", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
				cookie: [...user.jar].map(([name, value]) => `${name}=${value}`).join("; "),
			},
			body: JSON.stringify({ image: "https://evil.example/pixel.png" }),
		});
		assert.equal((await m.authRoute.POST(request)).status, 404);
		assert.equal((await readUser(user)).image ?? null, null);
	});
});

describe("the account menu", () => {
	test("shows whether the account sends, and what to do when it doesn't", async () => {
		const user = await signIn("status@example.com");
		assert.deepEqual(m.state.getSendingStatus(user.account), { label: "No plan", hint: "Pick a plan to send", tone: "gray" });
		const paid = await activate(user);
		assert.deepEqual(m.state.getSendingStatus(paid), { label: "Sending on", hint: null, tone: "green" });
		assert.deepEqual(m.state.getSendingStatus({ ...paid, status: "paused", pauseReason: "Review" }), {
			label: "Account blocked",
			hint: "This account is blocked: Review. Contact hello@mailcheap.ai to unblock it.",
			tone: "red",
		});
		assert.equal(await withEnv({ SENDING_ENABLED: "false" }, () => m.state.getSendingStatus(paid).label), "Sending off");
	});

	test("asks before signing out, like every sign-out button, and nothing signs out without asking", async () => {
		const asked = [];
		let answer = false;
		globalThis.window = {
			confirm(question) {
				asked.push(question);
				return answer;
			},
		};
		try {
			assert.equal(m.signOut.askToSignOut(), false);
			answer = true;
			assert.equal(m.signOut.askToSignOut(), true);
			assert.deepEqual(asked, ["Sign out of MailCheap?", "Sign out of MailCheap?"]);
		} finally {
			delete globalThis.window;
		}

		const menu = await readFile(join(ROOT, "components/MenuUser.jsx"), "utf8");
		assert.match(menu, /if \(askToSignOut\(\)\) startSigningOut\(\(\) => signOut\(\)\);/, "the menu signs out only when the answer is yes");
		assert.match(menu, /onSelect=\{signOutAfterAsking\}/);
		assert.match(await readFile(join(ROOT, "components/ButtonSignout.jsx"), "utf8"), /if \(!askToSignOut\(\)\) event\.preventDefault\(\);/);

		for (const file of await findSources((source) => /import \{[^}]*\bsignOut\b[^}]*\} from "@\/app\/signin\/actions"/.test(source))) {
			const source = await readFile(join(ROOT, file), "utf8");
			assert.ok(source.includes("<ButtonSignout") || source.includes("askToSignOut()"), `${file} signs out without asking`);
		}
	});

	test("holds Account, Billing, the theme menu and Sign out, so the newsletter navigation has no Billing", async () => {
		const menu = await readFile(join(ROOT, "components/MenuUser.jsx"), "utf8");
		for (const item of ['href="/account"', 'href="/billing"', "<RadioGroupTheme />", "Sign out"]) assert.ok(menu.includes(item), item);
		assert.doesNotMatch(await readFile(join(ROOT, "components/NavLinks.jsx"), "utf8"), /\/billing/);
	});
});

async function findSources(matches) {
	const files = [];
	for (const dir of ["app", "components"]) {
		for (const name of await readdir(join(ROOT, dir), { recursive: true })) {
			if (!/\.jsx?$/.test(name)) continue;
			const file = `${dir}/${name}`;
			if (matches(await readFile(join(ROOT, file), "utf8"))) files.push(file);
		}
	}
	return files.sort();
}
