import assert from "node:assert/strict";
import { test } from "node:test";
import { LANGUAGES, getLanguageName, normalizeLanguage, toOpenGraphLocale } from "../lib/languages.js";

test("codes, tags with a region and old codes become one base language", () => {
	assert.equal(normalizeLanguage("fr"), "fr");
	assert.equal(normalizeLanguage(" EN "), "en");
	assert.equal(normalizeLanguage("pt-BR"), "pt");
	assert.equal(normalizeLanguage("en_US"), "en");
	assert.equal(normalizeLanguage("zh-Hant-TW"), "zh");
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
	assert.equal(normalizeLanguage("Portuguese (Brazil)"), "pt");
	assert.equal(normalizeLanguage("日本語"), "ja");
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
});

test("og:locale gets the territory most of the language's readers live in", () => {
	assert.equal(toOpenGraphLocale("en"), "en_US");
	assert.equal(toOpenGraphLocale("pt"), "pt_BR");
	assert.equal(toOpenGraphLocale("fr"), "fr_FR");
	assert.equal(toOpenGraphLocale(undefined), "en_US");
});
