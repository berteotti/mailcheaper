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

// Regional variants written differently enough to tell apart, by their tag. One stores as its language and its
// region (languageRegion: pt and BR), so whatever looks for Portuguese finds it too. Another region is its language.
export const LANGUAGE_VARIANTS = {
	"en-GB": "English (UK)",
	"en-US": "English (US)",
	"es-419": "Spanish (Latin America)",
	"es-ES": "Spanish (Spain)",
	"fr-CA": "French (Canada)",
	"pt-BR": "Portuguese (Brazil)",
	"pt-PT": "Portuguese (Portugal)",
	"zh-CN": "Chinese (China)",
	"zh-TW": "Chinese (Taiwan)",
};

// Every language and variant by name, for pickers: each variant right after its language.
export const LANGUAGE_OPTIONS = Object.entries({ ...LANGUAGES, ...LANGUAGE_VARIANTS }).sort(([, a], [, b]) => a.localeCompare(b));

export const DEFAULT_LANGUAGE = "en";
// An import's language filter: the rows without a language. Longer than any code, so it can't be one.
export const NO_LANGUAGE = "none";

// Bokmål and Nynorsk readers read the same newsletter.
const ALIASES = { nb: "no", nn: "no" };

let languagesByName;

// "Français" and "francais" alike.
function nameKey(name) {
	return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

// Our English names, Intl's (Brazilian Portuguese) and each one's own (português (Brasil)), where Intl has them.
function getLanguagesByName() {
	if (languagesByName) return languagesByName;
	languagesByName = new Map();
	for (const [code, name] of Object.entries({ ...LANGUAGES, ...LANGUAGE_VARIANTS })) {
		const names = [name];
		try {
			names.push(new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(code));
			names.push(new Intl.DisplayNames([code], { type: "language", fallback: "none" }).of(code));
		} catch {
			// Our name is enough.
		}
		for (const each of names) if (each && !languagesByName.has(nameKey(each))) languagesByName.set(nameKey(each), code);
	}
	return languagesByName;
}

function fromTag(text) {
	try {
		const [tag] = Intl.getCanonicalLocales(text.replaceAll("_", "-"));
		const { language, region } = new Intl.Locale(tag);
		const code = ALIASES[language] ?? language;
		if (region && Object.hasOwn(LANGUAGE_VARIANTS, `${code}-${region}`)) return `${code}-${region}`;
		return Object.hasOwn(LANGUAGES, code) ? code : null;
	} catch {
		return null;
	}
}

// A tag (fr, pt-BR, en_US, eng) or a name (French, Português (Brasil)) as one of LANGUAGES or LANGUAGE_VARIANTS,
// or null. A region that isn't a variant falls back to its language (pt-AO is pt), like a name with one we don't know.
export function normalizeLanguage(value) {
	const text = String(value ?? "").trim().slice(0, 40);
	if (!text) return null;
	const byName = getLanguagesByName();
	return fromTag(text) ?? byName.get(nameKey(text)) ?? byName.get(nameKey(text.replace(/\s*\(.*\)$/, ""))) ?? null;
}

export function getLanguageName(code) {
	return LANGUAGE_VARIANTS[code] ?? LANGUAGES[code] ?? code;
}

// A row's language and languageRegion as one tag (pt-BR), or null.
export function getLanguageTag(row) {
	if (!row?.language) return null;
	return row.languageRegion ? `${row.language}-${row.languageRegion}` : row.language;
}

// A tag as the two columns it's stored in.
export function splitLanguage(tag) {
	if (!tag) return { language: null, languageRegion: null };
	const [language, languageRegion = null] = tag.split("-");
	return { language, languageRegion };
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
