import assert from "node:assert/strict";
import { test } from "node:test";

// Even if this broke, the AWS SDK finds no other credentials here, so the test can never reach a real account.
for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY"]) {
	delete process.env[key];
}
process.env.AWS_CONFIG_FILE = "/nonexistent/aws-config";
process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/aws-credentials";
process.env.AWS_EC2_METADATA_DISABLED = "true";

const ses = await import("../lib/ses.js");

test("without MailCheap's own SES keys nothing falls back to the machine's AWS credentials", async () => {
	assert.match((await ses.getSesAccount({ fresh: true })).error, /SES is not configured/);
	assert.match((await ses.getDomainIdentity("example.com")).error, /SES is not configured/);
	await assert.rejects(ses.createTenant("mc-test", { accountId: "a" }), /SES is not configured/);

	process.env.SENDING_ENABLED = "true";
	try {
		await assert.rejects(
			ses.sendSesEmail({ from: "a@example.com", to: "b@example.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi" }),
			/needs the account's SES tenant/
		);
		await assert.rejects(
			ses.sendSesEmail({
				from: "a@example.com",
				to: "b@example.com",
				subject: "Hi",
				html: "<p>Hi</p>",
				text: "Hi",
				tenantName: "mc-test",
				configurationSet: "mc-test",
			}),
			/SES is not configured/
		);
	} finally {
		delete process.env.SENDING_ENABLED;
	}
});
