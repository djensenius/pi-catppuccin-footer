import { describe, expect, it } from "vitest";
import { compactNumber, DEFAULT_CONFIG, formatCwd, parseGitDiff, splitIcon } from "../extensions/catppuccin-footer.js";

describe("catppuccin footer utilities", () => {
	it("formats compact numbers", () => {
		expect(compactNumber(999)).toBe("999");
		expect(compactNumber(1200)).toBe("1.2k");
		expect(compactNumber(1_250_000)).toBe("1.3m");
	});

	it("splits a leading icon from the section label", () => {
		expect(splitIcon(" ~/Developer/pi-demo")).toEqual({ icon: "", label: "~/Developer/pi-demo" });
		expect(splitIcon("plain-label")).toEqual({ icon: "", label: "plain-label" });
	});

	it("parses clean git porcelain output", () => {
		expect(parseGitDiff("")).toBe(" ✓");
		expect(parseGitDiff("\n")).toBe(" ✓");
	});

	it("parses added, modified, and deleted git porcelain output", () => {
		const porcelain = ["?? new-file.ts", " M modified.ts", "A  added.ts", "D  deleted.ts", "R  renamed.ts"].join("\n");
		expect(parseGitDiff(porcelain)).toBe(" +2 ~2 -1");
	});

	it("formats cwd using basename style", () => {
		expect(formatCwd("/Users/djensenius/Developer/pi-demo", "basename")).toBe("pi-demo");
	});

	it("ships with a tmux default style", () => {
		expect(DEFAULT_CONFIG.style).toBe("tmux");
		expect(DEFAULT_CONFIG.left).toContain("cwd");
		expect(DEFAULT_CONFIG.right).toContain("model");
	});
});
