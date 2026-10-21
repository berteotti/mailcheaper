import assert from "node:assert/strict";
import { test } from "node:test";
import {
	LANGUAGES,
	LANGUAGE_VARIANTS,
	getLanguageName,
	getLanguageTag,
	matchLanguage,
	normalizeLanguage,
	splitLanguage,
	toOpenGraphLocale,
} from "../lib/languages.js";

test("codes and old codes become one language, and a region its variant when MailCheap tells it apart", () => {
	assert.equal(normalizeLanguage("fr"), "fr");
	assert.equal(normalizeLanguage(" EN "), "en");
	assert.equal(normalizeLanguage("pt-BR"), "pt-BR");
	assert.equal(normalizeLanguage("pt-br"), "pt-BR");
	assert.equal(normalizeLanguage("pt_BR"), "pt-BR");
	assert.equal(normalizeLanguage("en_US"), "en-US");
	assert.equal(normalizeLanguage("es-419"), "es-419");
	assert.equal(normalizeLanguage("zh-Hant-TW"), "zh-TW");
	assert.equal(normalizeLanguage("pt-AO"), "pt", "a region it doesn't tell apart");
	assert.equal(normalizeLanguage("de-CH"), "de");
	assert.equal(normalizeLanguage("nb-NO"), "no");
	assert.equal(normalizeLanguage("eng"), "en");
	assert.equal(normalizeLanguage("iw"), "he");
	assert.equal(normalizeLanguage("tl"), "fil");
	assert.equal(normalizeLanguage("nb"), "no");
	assert.equal(normalizeLanguage("nn"), "no");
});

test("names in English or in the language itself are read too", () => {
	assert.equal(normalizeLanguage("French"), "fr");
	assert.equal(normalizeLanguage("Français"), "fr");
	assert.equal(normalizeLanguage("francais"), "fr");
	assert.equal(normalizeLanguage("Deutsch"), "de");
	assert.equal(normalizeLanguage("Portuguese (Brazil)"), "pt-BR");
	assert.equal(normalizeLanguage("Brazilian Portuguese"), "pt-BR");
	assert.equal(normalizeLanguage("português (Brasil)"), "pt-BR");
	assert.equal(normalizeLanguage("Português"), "pt");
	assert.equal(normalizeLanguage("Portuguese (Angola)"), "pt", "a region it doesn't tell apart");
	assert.equal(normalizeLanguage("日本語"), "ja");
});

test("a variant is stored as its language and its region, and read back as one tag", () => {
	assert.deepEqual(splitLanguage("pt-BR"), { language: "pt", languageRegion: "BR" });
	assert.deepEqual(splitLanguage("es-419"), { language: "es", languageRegion: "419" });
	assert.deepEqual(splitLanguage("fr"), { language: "fr", languageRegion: null });
	assert.deepEqual(splitLanguage(null), { language: null, languageRegion: null });
	assert.equal(getLanguageTag({ language: "pt", languageRegion: "BR" }), "pt-BR");
	assert.equal(getLanguageTag({ language: "pt", languageRegion: null }), "pt");
	assert.equal(getLanguageTag({ language: null }), null);
	assert.equal(getLanguageName("pt-BR"), "Portuguese (Brazil)");
});

test("anything else is no language", () => {
	for (const value of ["", "  ", null, undefined, "xx", "klingon", "x-pig-latin", "123", "en;drop table"]) {
		assert.equal(normalizeLanguage(value), null, String(value));
	}
});

test("every language's code is the one Intl gives back, so the browser and the server agree", () => {
	for (const code of Object.keys(LANGUAGES)) {
		assert.match(code, /^[a-z]{2,3}$/);
		assert.equal(normalizeLanguage(code), code);
	}
	assert.equal(getLanguageName("pt"), "Portuguese");
	for (const tag of Object.keys(LANGUAGE_VARIANTS)) {
		assert.equal(normalizeLanguage(tag), tag);
		assert.ok(Object.hasOwn(LANGUAGES, splitLanguage(tag).language), `${tag}'s language`);
	}
});

test("og:locale gets the territory most of the language's readers live in", () => {
	assert.equal(toOpenGraphLocale("en"), "en_US");
	assert.equal(toOpenGraphLocale("pt"), "pt_BR");
	assert.equal(toOpenGraphLocale("fr"), "fr_FR");
	assert.equal(toOpenGraphLocale("en-GB"), "en_GB");
	assert.equal(toOpenGraphLocale("pt-PT"), "pt_PT");
	assert.equal(toOpenGraphLocale(undefined), "en_US");
});

test("a reader gets their own tag, else their language, else another variant of it, else nothing", () => {
	const tags = ["en", "pt-BR", "pt-PT", "es-419"];
	assert.equal(matchLanguage("pt-PT", tags), "pt-PT");
	assert.equal(matchLanguage("en-GB", tags), "en", "the language itself first");
	assert.equal(matchLanguage("pt", tags), "pt-BR", "the first variant given");
	assert.equal(matchLanguage("es-ES", tags), "es-419");
	assert.equal(matchLanguage("fr", tags), null);
	assert.equal(matchLanguage("pt-BR", ["pt", "pt-BR"]), "pt-BR");
	assert.equal(matchLanguage("pt-BR", ["pt-PT", "pt"]), "pt");
});
