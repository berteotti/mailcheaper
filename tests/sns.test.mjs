import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { POST as postSesWebhook } from "../app/api/webhooks/ses/route.js";
import {
	buildSigningString,
	createSnsVerifier,
	isValidSigningCertUrl,
	isValidSubscribeUrl,
} from "../lib/sns.js";
import { env } from "./helpers/bindings.mjs";
import { database } from "./helpers/d1.mjs";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const CERT_URL =
	"https://sns.us-east-1.amazonaws.com/SimpleNotificationService-9c6465fa7f48f5cacd23014631ec1136.pem";
const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:mailcheap-ses-events";

const notification = {
	Type: "Notification",
	MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
	TopicArn: TOPIC_ARN,
	Subject: "Amazon SES Email Event Notification",
	Message: JSON.stringify({ eventType: "Delivery", mail: { messageId: "0100abc" } }),
	Timestamp: "2026-10-04T12:00:00.000Z",
	UnsubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${TOPIC_ARN}:1`,
};

const confirmation = {
	Type: "SubscriptionConfirmation",
	MessageId: "165545c9-2a5c-472c-8df2-7ff2be2b3b1b",
	Token: "example-subscription-token",
	TopicArn: TOPIC_ARN,
	Message: `You have chosen to subscribe to the topic ${TOPIC_ARN}.`,
	SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${TOPIC_ARN}&Token=example`,
	Timestamp: "2026-10-04T12:00:00.000Z",
};

function signMessage(message, signatureVersion = "2", key = privateKey) {
	const unsigned = { SigningCertURL: CERT_URL, ...message, SignatureVersion: signatureVersion };
	const algorithm = signatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256";
	const signature = crypto
		.createSign(algorithm)
		.update(buildSigningString(unsigned))
		.sign(key, "base64");
	return { ...unsigned, Signature: signature };
}

// Like fetch on Workers: redirect "error" throws, and a redirect comes back as it is. Unknown URLs redirect.
function mockWorkersFetch(t, responses) {
	const requests = [];
	t.mock.method(globalThis, "fetch", async (input, init = {}) => {
		const redirect = init.redirect ?? "follow";
		if (!["follow", "manual"].includes(redirect)) throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
		const url = String(input);
		requests.push({ url, redirect });
		return responses[url]?.() ?? new Response(null, { status: 302, headers: { Location: "https://example.com/elsewhere" } });
	});
	return requests;
}

function createTestVerifier() {
	const requests = [];
	const verify = createSnsVerifier({
		fetchCertificate: async (url) => {
			requests.push(url);
			return publicKeyPem;
		},
	});
	return { verify, requests };
}

test("the signing string follows the AWS format for each message type", () => {
	const lines = (keys, message) => keys.flatMap((key) => [key, message[key]]).concat("").join("\n");

	assert.equal(
		buildSigningString(notification),
		lines(["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"], notification)
	);
	const withoutSubject = { ...notification };
	delete withoutSubject.Subject;
	assert.equal(
		buildSigningString(withoutSubject),
		lines(["Message", "MessageId", "Timestamp", "TopicArn", "Type"], withoutSubject)
	);
	assert.equal(
		buildSigningString(confirmation),
		lines(
			["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
			confirmation
		)
	);

	assert.equal(buildSigningString({ ...notification, Type: "Other" }), null);
	assert.equal(buildSigningString({ ...notification, Type: "constructor" }), null);
	assert.equal(buildSigningString({ ...notification, Message: undefined }), null);
	assert.equal(buildSigningString({ ...confirmation, Token: 42 }), null);
	assert.equal(buildSigningString(null), null);
});

test("signature versions 1 (SHA1) and 2 (SHA256) verify", async () => {
	const { verify } = createTestVerifier();
	const withoutSubject = { ...notification };
	delete withoutSubject.Subject;

	assert.equal(await verify(signMessage(notification, "1")), true);
	assert.equal(await verify(signMessage(notification, "2")), true);
	assert.equal(await verify(signMessage(withoutSubject)), true);
	assert.equal(await verify(signMessage(confirmation, "1")), true);
	assert.equal(await verify(signMessage({ ...confirmation, Type: "UnsubscribeConfirmation" })), true);
});

test("tampered, forged, and malformed messages are rejected", async () => {
	const { verify } = createTestVerifier();
	const signed = signMessage(notification);
	const otherKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

	const rejected = [
		{ ...signed, Message: signed.Message.replace("Delivery", "Bounce") },
		{ ...signed, TopicArn: `${TOPIC_ARN}-other` },
		{ ...signed, Subject: "Changed" },
		{ ...signed, Type: "SubscriptionConfirmation" },
		{ ...signed, Signature: signMessage({ ...notification, MessageId: "other" }).Signature },
		{ ...signed, Signature: signMessage(notification, "2", otherKey).Signature },
		{ ...signed, SignatureVersion: "1" },
		{ ...signed, SignatureVersion: "3" },
		{ ...signed, SignatureVersion: "constructor" },
		{ ...signed, SignatureVersion: 2 },
		{ ...signed, Signature: undefined },
		{ ...signed, Signature: "bm90IGEgc2lnbmF0dXJl" },
		null,
		"text",
	];
	for (const message of rejected) assert.equal(await verify(message), false);
});

test("certificates are only fetched from https://sns.<region>.amazonaws.com/SimpleNotificationService-*.pem", async () => {
	const { verify, requests } = createTestVerifier();
	const certPath = "/SimpleNotificationService-9c6465fa7f48f5cacd23014631ec1136.pem";
	const rejectedUrls = [
		`http://sns.us-east-1.amazonaws.com${certPath}`,
		`https://sns.us-east-1.amazonaws.com.evil.com${certPath}`,
		`https://evil.com/sns.us-east-1.amazonaws.com${certPath}`,
		`https://sns.amazonaws.com${certPath}`,
		`https://s3.us-east-1.amazonaws.com${certPath}`,
		`https://sns.s3.amazonaws.com${certPath}`,
		`https://sns.s3-us-west-2.amazonaws.com${certPath}`,
		`https://sns.s3.us-west-2.amazonaws.com${certPath}`,
		`https://sns.s3-website-us-east-1.amazonaws.com${certPath}`,
		`https://sns.us_east_1.amazonaws.com${certPath}`,
		`https://sns.cn-north-1.amazonaws.com.cn${certPath}`,
		`https://sns.us-east-1.amazonaws.com:8443${certPath}`,
		`https://user:pass@sns.us-east-1.amazonaws.com${certPath}`,
		"https://sns.us-east-1.amazonaws.com/cert.pem",
		"https://sns.us-east-1.amazonaws.com/bucket/SimpleNotificationService-abc.pem",
		"https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.txt",
		"https://sns.us-east-1.amazonaws.com/SimpleNotificationService-.pem",
		`https://sns.us-east-1.amazonaws.com${certPath}?x=1`,
		`https://sns.us-east-1.amazonaws.com${certPath}#x`,
		"not a url",
		undefined,
	];
	for (const url of rejectedUrls) {
		assert.equal(isValidSigningCertUrl(url), false, String(url));
		const message = signMessage({ ...notification, SigningCertURL: url });
		assert.equal(await verify(message), false, String(url));
	}
	assert.deepEqual(requests, []);

	assert.equal(isValidSigningCertUrl(CERT_URL), true);
	assert.equal(isValidSigningCertUrl(`https://sns.eu-central-1.amazonaws.com${certPath}`), true);
	assert.equal(isValidSigningCertUrl(`https://sns.us-gov-west-1.amazonaws.com${certPath}`), true);
});

test("subscription URLs must point at SNS over https", () => {
	assert.equal(isValidSubscribeUrl(confirmation.SubscribeURL), true);
	assert.equal(isValidSubscribeUrl(confirmation.SubscribeURL.replace("https:", "http:")), false);
	assert.equal(isValidSubscribeUrl("https://example.com/?Action=ConfirmSubscription"), false);
	assert.equal(isValidSubscribeUrl("https://sns.s3.amazonaws.com/?Action=ConfirmSubscription"), false);
	assert.equal(isValidSubscribeUrl(null), false);
});

test("certificates are cached per URL and failed downloads are retried", async () => {
	let calls = 0;
	const verify = createSnsVerifier({
		fetchCertificate: async () => {
			calls++;
			if (calls === 1) throw new Error("network down");
			return publicKeyPem;
		},
	});
	const signed = signMessage(notification);

	assert.equal(await verify(signed), false);
	assert.equal(await verify(signed), true);
	assert.equal(await verify(signMessage(confirmation)), true);
	assert.equal(calls, 2);
});

test("a certificate download that isn't PEM is rejected", async () => {
	const verify = createSnsVerifier({ fetchCertificate: async () => "<html>Not found</html>" });
	assert.equal(await verify(signMessage(notification)), false);
});

test("certificates download through Workers' fetch, and one behind a redirect is refused", async (t) => {
	const requests = mockWorkersFetch(t, { [CERT_URL]: () => new Response(publicKeyPem) });
	const verify = createSnsVerifier();
	const redirected = "https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-9c6465fa7f48f5cacd23014631ec1136.pem";

	assert.equal(await verify(signMessage(notification)), true);
	assert.equal(await verify(signMessage({ ...notification, SigningCertURL: redirected })), false);
	assert.deepEqual(requests, [{ url: CERT_URL, redirect: "manual" }, { url: redirected, redirect: "manual" }]);
});

test("the SES webhook confirms its subscription and stores each event as a job, on Workers' fetch", async (t) => {
	const requests = mockWorkersFetch(t, {
		[CERT_URL]: () => new Response(publicKeyPem),
		[confirmation.SubscribeURL]: () => new Response("<ConfirmSubscriptionResponse/>"),
	});
	const db = database(t);
	env.JOBS_QUEUE = { async sendBatch() {} };
	process.env.SES_SNS_TOPIC_ARN = TOPIC_ARN;
	t.after(() => {
		delete env.JOBS_QUEUE;
		delete process.env.SES_SNS_TOPIC_ARN;
	});
	t.mock.method(console, "log", () => {});
	const post = (message) => postSesWebhook(new Request("https://mail.example.com/api/webhooks/ses", { method: "POST", body: JSON.stringify(message) }));

	assert.equal((await post(signMessage(confirmation))).status, 200);
	assert.ok(requests.some(({ url, redirect }) => url === confirmation.SubscribeURL && redirect === "manual"));

	assert.equal((await post(signMessage(notification))).status, 200);
	const job = db.sqlite.prepare("SELECT kind, payload FROM job_outbox WHERE _id = ?").get(`ses-event:${notification.MessageId}`);
	assert.equal(job.kind, "ses-event");
	assert.equal(JSON.parse(job.payload).eventType, "Delivery");
});
