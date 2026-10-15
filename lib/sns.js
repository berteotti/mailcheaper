import crypto from "node:crypto";

// Exactly sns.<region>.amazonaws.com: a looser pattern also matched S3 bucket hosts like sns.s3.amazonaws.com.
const AWS_SNS_HOST = /^sns\.[a-z]{2}(?:-[a-z]+)+-\d+\.amazonaws\.com$/;
const SIGNING_CERT_PATH = /^\/SimpleNotificationService-[a-z0-9]+\.pem$/i;
const SIGNATURE_ALGORITHMS = new Map([
	["1", "RSA-SHA1"],
	["2", "RSA-SHA256"],
]);
const SUBSCRIPTION_KEYS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
// AWS spec: keys in byte order, Subject only when the notification has one.
const SIGNED_KEYS = new Map([
	["Notification", ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]],
	["SubscriptionConfirmation", SUBSCRIPTION_KEYS],
	["UnsubscribeConfirmation", SUBSCRIPTION_KEYS],
]);
const OPTIONAL_KEYS = new Set(["Subject"]);
const MAX_CACHED_CERTIFICATES = 20;
const PEM_PATTERN = /-----BEGIN (CERTIFICATE|PUBLIC KEY)-----/;

function parseAwsSnsUrl(value) {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		const isAws =
			url.protocol === "https:" &&
			AWS_SNS_HOST.test(url.hostname) &&
			!url.port &&
			!url.username &&
			!url.password;
		return isAws ? url : null;
	} catch {
		return null;
	}
}

export function isValidSigningCertUrl(value) {
	const url = parseAwsSnsUrl(value);
	return Boolean(url && SIGNING_CERT_PATH.test(url.pathname) && !url.search && !url.hash);
}

export function isValidSubscribeUrl(value) {
	return Boolean(parseAwsSnsUrl(value));
}

export function buildSigningString(message) {
	const keys = SIGNED_KEYS.get(message?.Type);
	if (!keys) return null;

	let signingString = "";
	for (const key of keys) {
		const value = Object.hasOwn(message, key) ? message[key] : undefined;
		if (value == null && OPTIONAL_KEYS.has(key)) continue;
		if (typeof value !== "string") return null;
		signingString += `${key}\n${value}\n`;
	}
	return signingString;
}

async function fetchAwsCertificate(url) {
	const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
	if (!response.ok) throw new Error(`Certificate request failed with ${response.status}`);
	return response.text();
}

// The key out of the signing certificate. Read through X509Certificate, which Workers' node:crypto supports,
// rather than handing the certificate PEM to verify().
function toPublicKey(pem) {
	return pem.includes("-----BEGIN CERTIFICATE-----") ? new crypto.X509Certificate(pem).publicKey : crypto.createPublicKey(pem);
}

export function createSnsVerifier({ fetchCertificate = fetchAwsCertificate } = {}) {
	const certificates = new Map();

	function getCertificate(url) {
		if (!certificates.has(url)) {
			if (certificates.size >= MAX_CACHED_CERTIFICATES) certificates.clear();
			const pending = Promise.resolve(url)
				.then(fetchCertificate)
				.then((pem) => {
					if (!PEM_PATTERN.test(String(pem))) throw new Error("Certificate is not PEM");
					return String(pem);
				});
			certificates.set(url, pending);
			pending.catch(() => certificates.delete(url));
		}
		return certificates.get(url);
	}

	return async function verifySnsMessage(message) {
		const algorithm = SIGNATURE_ALGORITHMS.get(message?.SignatureVersion);
		const signingString = buildSigningString(message);
		if (!algorithm || !signingString || typeof message.Signature !== "string") return false;
		if (!isValidSigningCertUrl(message.SigningCertURL)) return false;

		try {
			const certificate = await getCertificate(message.SigningCertURL);
			return crypto
				.createVerify(algorithm)
				.update(signingString, "utf8")
				.verify(toPublicKey(certificate), message.Signature, "base64");
		} catch {
			return false;
		}
	};
}

export const verifySnsMessage = createSnsVerifier();
