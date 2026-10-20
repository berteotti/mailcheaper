// The languages a newsletter or a contact can have, by the code Intl.getCanonicalLocales gives them. A fixed
// list, not whatever Intl knows: the browser parsing an import and the server checking it must agree.
export const LANGUAGES = {
	af: "Afrikaans",
	am: "Amharic",
	ar: "Arabic",
	az: "Azerbaijani",
	be: "Belarusian",
	bg: "Bulgarian",
	bn: "Bengali",
	bs: "Bosnian",
	ca: "Catalan",
	cs: "Czech",
	cy: "Welsh",
	da: "Danish",
	de: "German",
	el: "Greek",
	en: "English",
	eo: "Esperanto",
	es: "Spanish",
	et: "Estonian",
	eu: "Basque",
	fa: "Persian",
	fi: "Finnish",
	fil: "Filipino",
	fr: "French",
	ga: "Irish",
	gd: "Scottish Gaelic",
	gl: "Galician",
	gu: "Gujarati",
	ha: "Hausa",
	he: "Hebrew",
	hi: "Hindi",
	hr: "Croatian",
	ht: "Haitian Creole",
	hu: "Hungarian",
	hy: "Armenian",
	id: "Indonesian",
	ig: "Igbo",
	is: "Icelandic",
	it: "Italian",
	ja: "Japanese",
	jv: "Javanese",
	ka: "Georgian",
	kk: "Kazakh",
	km: "Khmer",
	kn: "Kannada",
	ko: "Korean",
	ku: "Kurdish",
	ky: "Kyrgyz",
	la: "Latin",
	lb: "Luxembourgish",
	lo: "Lao",
	lt: "Lithuanian",
	lv: "Latvian",
	mi: "Māori",
	mk: "Macedonian",
	ml: "Malayalam",
	mn: "Mongolian",
	mr: "Marathi",
	ms: "Malay",
	mt: "Maltese",
	my: "Burmese",
	ne: "Nepali",
	nl: "Dutch",
	no: "Norwegian",
	pa: "Punjabi",
	pl: "Polish",
	ps: "Pashto",
	pt: "Portuguese",
	ro: "Romanian",
	ru: "Russian",
	rw: "Kinyarwanda",
	si: "Sinhala",
	sk: "Slovak",
	sl: "Slovenian",
	so: "Somali",
	sq: "Albanian",
	sr: "Serbian",
	sv: "Swedish",
	sw: "Swahili",
	ta: "Tamil",
	te: "Telugu",
	tg: "Tajik",
	th: "Thai",
	tk: "Turkmen",
	tr: "Turkish",
	uk: "Ukrainian",
	ur: "Urdu",
	uz: "Uzbek",
	vi: "Vietnamese",
	xh: "Xhosa",
	yi: "Yiddish",
	yo: "Yoruba",
	zh: "Chinese",
	zu: "Zulu",
};

export const DEFAULT_LANGUAGE = "en";

// Bokmål and Nynorsk readers read the same newsletter.
const ALIASES = { nb: "no", nn: "no" };

let languagesByName;

// "Français" and "francais" alike, without a region: "Portuguese (Brazil)".
function nameKey(name) {
	return name
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/\s*\(.*\)$/, "")
		.trim();
}

// English names, and each language's own name where Intl has one.
function getLanguagesByName() {
	if (languagesByName) return languagesByName;
	languagesByName = new Map();
	for (const [code, name] of Object.entries(LANGUAGES)) {
		languagesByName.set(nameKey(name), code);
		try {
			const ownName = new Intl.DisplayNames([code], { type: "language", fallback: "none" }).of(code);
			if (ownName && !languagesByName.has(nameKey(ownName))) languagesByName.set(nameKey(ownName), code);
		} catch {
			// The English name is enough.
		}
	}
	return languagesByName;
}

function fromTag(text) {
	try {
		const [tag] = Intl.getCanonicalLocales(text.replaceAll("_", "-"));
		const { language } = new Intl.Locale(tag);
		const code = ALIASES[language] ?? language;
		return Object.hasOwn(LANGUAGES, code) ? code : null;
	} catch {
		return null;
	}
}

// A tag (fr, pt-BR, en_US, eng) or a name (French, Français) as one of LANGUAGES, or null.
export function normalizeLanguage(value) {
	const text = String(value ?? "").trim().slice(0, 40);
	if (!text) return null;
	return fromTag(text) ?? getLanguagesByName().get(nameKey(text)) ?? null;
}

export function getLanguageName(code) {
	return LANGUAGES[code] ?? code;
}

// og:locale wants a territory: the one most people writing the language live in (pt → pt_BR).
export function toOpenGraphLocale(code) {
	try {
		const { language, region } = new Intl.Locale(code).maximize();
		return region ? `${language}_${region}` : language;
	} catch {
		return "en_US";
	}
}
