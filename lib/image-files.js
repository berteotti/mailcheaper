// The type comes from a file's first bytes, never from what the sender says, so nothing but pictures
// ends up on the CDN.
const SIGNATURES = [
	{ contentType: "image/png", extension: "png", signature: "\x89PNG" },
	{ contentType: "image/jpeg", extension: "jpg", signature: "\xff\xd8\xff" },
	{ contentType: "image/gif", extension: "gif", signature: "GIF8" },
	{ contentType: "image/webp", extension: "webp", signature: "RIFF", marker: "WEBP" },
];

function startsWith(bytes, signature, offset = 0) {
	return [...signature].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

export function detectImageType(bytes) {
	const match = SIGNATURES.find(({ signature, marker }) => startsWith(bytes, signature) && (!marker || startsWith(bytes, marker, 8)));
	return match ? { contentType: match.contentType, extension: match.extension } : null;
}

// Plain base64 or a data: URL.
export function decodeBase64Image(value) {
	const data = String(value ?? "").replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
	if (!data || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(data)) return null;
	return new Uint8Array(Buffer.from(data, "base64"));
}
