// WCAG contrast for every colour pairing the stylesheet uses for text, read from the
// stylesheet itself so a changed colour can't slip through.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const color = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const text_pairs: [string, string, string][] = [
  ["ink", "paper", "body text on the page"],
  ["ink", "surface", "body text on a card"],
  ["ink-soft", "paper", "muted text on the page"],
  ["ink-soft", "surface", "muted text on a card"],
  ["forest", "paper", "links on the page"],
  ["forest", "surface", "links and quiet buttons on a card"],
  ["surface", "forest", "primary button text"],
  ["mint-ink", "mint", "confirmed notices and badges"],
  ["amber-ink", "amber", "waiting notices and the testnet badge"],
  ["rose-ink", "rose", "failure notices"],
  ["rose-ink", "surface", "danger buttons"],
  ["ink", "mint", "suggestion chips and open badges use mint ink"],
];

test("every text colour pairing meets the 4.5:1 minimum", () => {
  assert.ok(Object.keys(color).length >= 12, "the stylesheet's colour tokens were found");
  for (const [fg, bg, where] of text_pairs) {
    const r = ratio(color[fg]!, color[bg]!);
    assert.ok(r >= 4.5, `${where}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
  }
});

// The ring is drawn 2px outside the control (outline-offset), so it sits on whatever is behind
// the control: the page, a card, or a notice. It never sits on a button's own fill.
test("the keyboard focus ring is visible on every surface it appears on", () => {
  for (const bg of ["paper", "surface", "mint", "amber", "rose"]) {
    const r = ratio(color.focus!, color[bg]!);
    assert.ok(r >= 3, `focus ring on ${bg} is ${r.toFixed(2)}:1`);
  }
});

test("the stylesheet respects reduced motion", () => {
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});
