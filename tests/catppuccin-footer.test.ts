import { describe, expect, it } from "vitest";
import {
	compactNumber,
	configureSection,
	configureStatusFilter,
	DEFAULT_CONFIG,
	formatCwd,
	getStatusItems,
	parseGitDiff,
	sanitizeStatusText,
	splitIcon,
} from "../extensions/catppuccin-footer.js";

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

	it("sanitizes status text for one-line footer segments", () => {
		expect(sanitizeStatusText("🟢 Browser\nconnected\t now")).toBe("🟢 Browser connected now");
	});

	it("extracts sorted plugin status items", () => {
		const footerData = {
			getExtensionStatuses: () =>
				new Map([
					["memctx", "🧠 memctx 12k"],
					["browser", "🟢 Browser connected"],
				]),
		};

		expect(getStatusItems(footerData)).toEqual(["🟢 Browser connected", "🧠 memctx 12k"]);
	});

	it("filters status items by smart key/text patterns", () => {
		const footerData = {
			getExtensionStatuses: () =>
				new Map([
					["memctx", "🧠 memctx 12k"],
					["browser", "🟢 Browser connected"],
				]),
		};
		const withoutBrowser = configureStatusFilter(DEFAULT_CONFIG, "hide", "browser");
		expect(getStatusItems(footerData, withoutBrowser)).toEqual(["🧠 memctx 12k"]);

		const onlyBrowser = configureStatusFilter(DEFAULT_CONFIG, "only", "Browser");
		expect(getStatusItems(footerData, onlyBrowser)).toEqual(["🟢 Browser connected"]);
	});

	it("turns sections on and off in config", () => {
		const withoutStatus = configureSection(DEFAULT_CONFIG, "off", "status");
		expect(withoutStatus.left).not.toContain("status");
		expect(withoutStatus.right).not.toContain("status");

		const withStatusOnLeft = configureSection(withoutStatus, "on", "status", "left");
		expect(withStatusOnLeft.left).toContain("status");
		expect(withStatusOnLeft.right).not.toContain("status");
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
