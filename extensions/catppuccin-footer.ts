import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, relative } from "node:path";

const CONFIG_PATH = ".pi/catppuccin-footer.json";
const GLOBAL_CONFIG_PATH = `${process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`}/catppuccin-footer.json`;

type Flavor = "latte" | "frappe" | "macchiato" | "mocha";
type ColorName = "mauve" | "blue" | "green" | "yellow" | "peach" | "pink" | "surface" | "muted" | "text";
export const SECTION_NAMES = [
	"mode",
	"cwd",
	"git",
	"gitDiff",
	"status",
	"state",
	"model",
	"tokens",
	"lastTokens",
	"cost",
	"time",
	"thinking",
] as const;
type SectionName = (typeof SECTION_NAMES)[number];
type CwdStyle = "short" | "basename" | "full";
type SegmentStyle = "twoTone" | "bubble" | "tmux";
type ActivityState = "idle" | "thinking" | "tools";

interface StatusItemsConfig {
	/** Empty include means show all status items not excluded. Non-empty include switches to allow-list mode. */
	include: string[];
	/** Exclude always wins over include. Patterns match status keys, text, or key:text; * wildcards are supported. */
	exclude: string[];
}

interface FooterConfig {
	enabled: boolean;
	flavor: Flavor;
	style: SegmentStyle;
	cwdStyle: CwdStyle;
	left: SectionName[];
	right: SectionName[];
	timeFormat: "HH:mm" | "HH:mm:ss";
	moduleSpacing: number;
	autoReload: boolean;
	colors: Partial<Record<SectionName, ColorName>>;
	aliases: Record<string, string>;
	statusItems: StatusItemsConfig;
}

export const DEFAULT_CONFIG: FooterConfig = {
	enabled: true,
	flavor: "mocha",
	style: "tmux",
	cwdStyle: "short",
	left: ["mode", "cwd", "git", "gitDiff"],
	right: ["status", "state", "model", "tokens", "lastTokens", "cost", "time"],
	timeFormat: "HH:mm",
	moduleSpacing: 0,
	autoReload: true,
	colors: {
		mode: "mauve",
		cwd: "blue",
		git: "green",
		gitDiff: "green",
		status: "peach",
		state: "pink",
		model: "mauve",
		tokens: "green",
		lastTokens: "blue",
		cost: "yellow",
		time: "peach",
		thinking: "pink",
	},
	aliases: {},
	statusItems: {
		include: [],
		exclude: [],
	},
};

const PALETTES = {
	latte: {
		base: "#eff1f5",
		text: "#4c4f69",
		surface: "#ccd0da",
		muted: "#6c6f85",
		mauve: "#8839ef",
		blue: "#1e66f5",
		green: "#40a02b",
		yellow: "#df8e1d",
		peach: "#fe640b",
		pink: "#ea76cb",
	},
	frappe: {
		base: "#303446",
		text: "#c6d0f5",
		surface: "#414559",
		muted: "#a5adce",
		mauve: "#ca9ee6",
		blue: "#8caaee",
		green: "#a6d189",
		yellow: "#e5c890",
		peach: "#ef9f76",
		pink: "#f4b8e4",
	},
	macchiato: {
		base: "#24273a",
		text: "#cad3f5",
		surface: "#363a4f",
		muted: "#a5adcb",
		mauve: "#c6a0f6",
		blue: "#8aadf4",
		green: "#a6da95",
		yellow: "#eed49f",
		peach: "#f5a97f",
		pink: "#f5bde6",
	},
	mocha: {
		base: "#1e1e2e",
		text: "#cdd6f4",
		surface: "#313244",
		muted: "#a6adc8",
		mauve: "#cba6f7",
		blue: "#89b4fa",
		green: "#a6e3a1",
		yellow: "#f9e2af",
		peach: "#fab387",
		pink: "#f5c2e7",
	},
} as const;

function hexToRgb(hex: string): [number, number, number] {
	const normalized = hex.replace("#", "");
	return [
		Number.parseInt(normalized.slice(0, 2), 16),
		Number.parseInt(normalized.slice(2, 4), 16),
		Number.parseInt(normalized.slice(4, 6), 16),
	];
}

function fg(hex: string, text: string): string {
	const [r, g, b] = hexToRgb(hex);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function bg(hex: string, text: string): string {
	const [r, g, b] = hexToRgb(hex);
	return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
}

function styled(text: string, foreground: string, background: string): string {
	const [fr, fgValue, fb] = hexToRgb(foreground);
	const [br, bgValue, bb] = hexToRgb(background);
	return `\x1b[38;2;${fr};${fgValue};${fb}m\x1b[48;2;${br};${bgValue};${bb}m${text}\x1b[39m\x1b[49m`;
}

export function readJsonConfig(path: string): Partial<FooterConfig> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Partial<FooterConfig>;
	} catch {
		return {};
	}
}

const SECTION_NAME_SET = new Set<string>(SECTION_NAMES);

export function isSectionName(value: string): value is SectionName {
	return SECTION_NAME_SET.has(value);
}

function normalizedSections(value: unknown, fallback: SectionName[]): SectionName[] {
	return Array.isArray(value) ? value.filter((section): section is SectionName => isSectionName(section)) : fallback;
}

function normalizedPatterns(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
		: [];
}

function mergedStatusItemsConfig(
	globalRaw: Partial<FooterConfig>,
	projectRaw: Partial<FooterConfig>,
): StatusItemsConfig {
	const merged = {
		...DEFAULT_CONFIG.statusItems,
		...(globalRaw.statusItems ?? {}),
		...(projectRaw.statusItems ?? {}),
	};

	return {
		include: normalizedPatterns(merged.include),
		exclude: normalizedPatterns(merged.exclude),
	};
}

export function readConfig(cwd: string): FooterConfig {
	const globalRaw = readJsonConfig(GLOBAL_CONFIG_PATH);
	const projectRaw = readJsonConfig(`${cwd}/${CONFIG_PATH}`);
	const merged = { ...globalRaw, ...projectRaw };

	return {
		...DEFAULT_CONFIG,
		...merged,
		left: normalizedSections(merged.left, DEFAULT_CONFIG.left),
		right: normalizedSections(merged.right, DEFAULT_CONFIG.right),
		colors: { ...DEFAULT_CONFIG.colors, ...(globalRaw.colors ?? {}), ...(projectRaw.colors ?? {}) },
		aliases: { ...DEFAULT_CONFIG.aliases, ...(globalRaw.aliases ?? {}), ...(projectRaw.aliases ?? {}) },
		statusItems: mergedStatusItemsConfig(globalRaw, projectRaw),
	};
}

export function formatCwd(cwd: string, style: CwdStyle): string {
	if (style === "full") return cwd;
	if (style === "basename") return basename(cwd) || cwd;

	const home = process.env.HOME;
	if (home && cwd === home) return "~";
	if (home && cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
	return cwd;
}

function formatTime(format: FooterConfig["timeFormat"]): string {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return format === "HH:mm:ss" ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

function assistantStats(ctx: any): {
	input: number;
	output: number;
	cost: number;
	lastInput: number;
	lastOutput: number;
} {
	let input = 0;
	let output = 0;
	let cost = 0;
	let lastInput = 0;
	let lastOutput = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		const usage = message.usage;
		if (!usage) continue;
		input += usage.input ?? 0;
		output += usage.output ?? 0;
		cost += usage.cost?.total ?? 0;
		lastInput = usage.input ?? 0;
		lastOutput = usage.output ?? 0;
	}

	return { input, output, cost, lastInput, lastOutput };
}

export function compactNumber(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

export function splitIcon(value: string): { icon: string; label: string } {
	const [icon, ...rest] = value.split(" ");
	return rest.length > 0 ? { icon, label: rest.join(" ") } : { icon: "", label: value };
}

export function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

interface StatusItemEntry {
	key: string;
	text: string;
}

function statusEntriesFrom(value: unknown): StatusItemEntry[] {
	if (!value) return [];

	if (value instanceof Map) {
		return [...value.entries()]
			.filter((entry): entry is [unknown, unknown] => entry.length >= 2 && entry[1] !== undefined && entry[1] !== null)
			.map(([key, text]) => ({ key: String(key), text: String(text) }));
	}

	if (Array.isArray(value)) {
		return value.flatMap((entry, index): StatusItemEntry[] => {
			if (typeof entry === "string") return [{ key: String(index), text: entry }];
			if (!entry || typeof entry !== "object") return [];

			const record = entry as Record<string, unknown>;
			const text = record.text ?? record.statusText ?? record.label ?? record.value;
			if (text === undefined || text === null) return [];
			return [{ key: String(record.key ?? record.id ?? record.name ?? index), text: String(text) }];
		});
	}

	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>)
			.filter(([, text]) => text !== undefined && text !== null)
			.map(([key, text]) => ({ key, text: String(text) }));
	}

	return [];
}

export function getStatusItemEntries(footerData: any): StatusItemEntry[] {
	const sources = [
		footerData.getExtensionStatuses?.(),
		footerData.getPluginStatuses?.(),
		footerData.getStatusItems?.(),
		footerData.getStatuses?.(),
	];
	const entries = sources.flatMap(statusEntriesFrom);
	const seenKeys = new Set<string>();

	return entries
		.sort((a, b) => a.key.localeCompare(b.key))
		.flatMap((entry) => {
			if (seenKeys.has(entry.key)) return [];
			seenKeys.add(entry.key);

			const text = sanitizeStatusText(entry.text);
			return text ? [{ ...entry, text }] : [];
		});
}

function patternMatchesStatusItem(pattern: string, entry: StatusItemEntry): boolean {
	const normalizedPattern = pattern.trim().toLowerCase();
	if (!normalizedPattern) return false;

	const candidates = [entry.key, entry.text, `${entry.key}:${entry.text}`].map((candidate) => candidate.toLowerCase());
	if (normalizedPattern.includes("*")) {
		const regex = new RegExp(`^${normalizedPattern.split("*").map(escapeRegExp).join(".*")}$`, "i");
		return candidates.some((candidate) => regex.test(candidate));
	}

	return candidates.some((candidate) => candidate === normalizedPattern || candidate.includes(normalizedPattern));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function statusItemVisible(entry: StatusItemEntry, statusItems: StatusItemsConfig): boolean {
	if (statusItems.exclude.some((pattern) => patternMatchesStatusItem(pattern, entry))) return false;
	if (statusItems.include.length > 0) {
		return statusItems.include.some((pattern) => patternMatchesStatusItem(pattern, entry));
	}
	return true;
}

export function getStatusItems(footerData: any, config: Pick<FooterConfig, "statusItems"> = DEFAULT_CONFIG): string[] {
	return getStatusItemEntries(footerData)
		.filter((entry) => statusItemVisible(entry, config.statusItems))
		.map((entry) => entry.text);
}

type SectionSide = "left" | "right";

type SectionAction = "on" | "off" | "toggle";

function defaultSectionSide(section: SectionName): SectionSide {
	return DEFAULT_CONFIG.left.includes(section) ? "left" : "right";
}

export function configureSection(
	config: FooterConfig,
	action: SectionAction,
	section: SectionName,
	side?: SectionSide,
): FooterConfig {
	const currentlyEnabled = config.left.includes(section) || config.right.includes(section);
	const enable = action === "toggle" ? !currentlyEnabled : action === "on";

	const next: FooterConfig = {
		...config,
		left: config.left.filter((entry) => entry !== section),
		right: config.right.filter((entry) => entry !== section),
	};

	if (enable) {
		const targetSide = side ?? defaultSectionSide(section);
		next[targetSide] = [...next[targetSide], section];
	}

	return next;
}

function uniquePatterns(patterns: string[]): string[] {
	return [...new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean))];
}

export function configureStatusFilter(
	config: FooterConfig,
	action: "hide" | "show" | "allow" | "only" | "reset",
	pattern?: string,
): FooterConfig {
	const statusItems = {
		include: [...config.statusItems.include],
		exclude: [...config.statusItems.exclude],
	};
	const trimmed = pattern?.trim();

	if (action === "reset" && !trimmed) {
		return { ...config, statusItems: { include: [], exclude: [] } };
	}

	if (!trimmed) return config;

	statusItems.include = statusItems.include.filter((entry) => entry !== trimmed);
	statusItems.exclude = statusItems.exclude.filter((entry) => entry !== trimmed);

	if (action === "hide") {
		statusItems.exclude.push(trimmed);
	} else if (action === "show") {
		if (config.statusItems.include.length > 0) statusItems.include.push(trimmed);
	} else if (action === "allow") {
		statusItems.include.push(trimmed);
	} else if (action === "only") {
		statusItems.include = [trimmed];
		statusItems.exclude = [];
	}

	return {
		...config,
		statusItems: {
			include: uniquePatterns(statusItems.include),
			exclude: uniquePatterns(statusItems.exclude),
		},
	};
}

export function parseGitDiff(porcelain: string): string | undefined {
	if (!porcelain.trim()) return " ✓";

	let added = 0;
	let modified = 0;
	let deleted = 0;

	for (const line of porcelain.split("\n")) {
		if (!line) continue;
		const x = line[0] ?? " ";
		const y = line[1] ?? " ";
		if (x === "?" && y === "?") added++;
		else {
			if (x === "A" || y === "A") added++;
			if (x === "M" || y === "M" || x === "R" || y === "R") modified++;
			if (x === "D" || y === "D") deleted++;
		}
	}

	const parts = [];
	if (added) parts.push(`+${added}`);
	if (modified) parts.push(`~${modified}`);
	if (deleted) parts.push(`-${deleted}`);
	return parts.length ? ` ${parts.join(" ")}` : " ✓";
}

function sectionValue(
	name: SectionName,
	ctx: any,
	footerData: any,
	config: FooterConfig,
	activityState: ActivityState,
	gitDiff: string | undefined,
): string | undefined {
	const stats = assistantStats(ctx);

	switch (name) {
		case "mode":
			return "π yolo";
		case "cwd":
			return ` ${formatCwd(ctx.cwd, config.cwdStyle)}`;
		case "git": {
			const branch = footerData.getGitBranch?.();
			return branch ? ` ${branch}` : undefined;
		}
		case "gitDiff":
			return gitDiff;
		case "status": {
			const items = getStatusItems(footerData, config);
			return items.length > 0 ? items.join("  ") : undefined;
		}
		case "state":
			return activityState === "tools" ? " tools" : activityState === "thinking" ? "󰚩 thinking" : "󰄬 idle";
		case "model": {
			const model = ctx.model?.id;
			return model ? `󰚩 ${config.aliases[model] ?? model}` : "󰚩 no model";
		}
		case "tokens":
			return `󰀂 ↑${compactNumber(stats.input)} ↓${compactNumber(stats.output)}`;
		case "lastTokens":
			return stats.lastInput || stats.lastOutput
				? `󰓅 +${compactNumber(stats.lastInput)}/${compactNumber(stats.lastOutput)}`
				: undefined;
		case "cost":
			return `󰝯 $${stats.cost.toFixed(3)}`;
		case "time":
			return ` ${formatTime(config.timeFormat)}`;
		case "thinking": {
			const level = typeof piApi?.getThinkingLevel === "function" ? piApi.getThinkingLevel() : undefined;
			return level ? `󰧑 ${level}` : undefined;
		}
	}
}

let piApi: ExtensionAPI | undefined;

function sectionColor(
	name: SectionName,
	index: number,
	config: FooterConfig,
	palette: (typeof PALETTES)[Flavor],
): string {
	const fallback: ColorName[] = ["mauve", "blue", "green", "yellow", "peach", "pink"];
	const colorName = config.colors[name] ?? fallback[index % fallback.length];
	return palette[colorName] ?? palette.mauve;
}

function renderSegments(
	names: SectionName[],
	ctx: any,
	footerData: any,
	config: FooterConfig,
	activityState: ActivityState,
	gitDiff: string | undefined,
	reverse = false,
): string {
	const palette = PALETTES[config.flavor] ?? PALETTES.mocha;
	const entries = names.flatMap((name): Array<{ name: SectionName; value: string }> => {
		if (name === "status") {
			return getStatusItems(footerData, config).map((value) => ({ name, value }));
		}

		const value = sectionValue(name, ctx, footerData, config, activityState, gitDiff);
		return value ? [{ name, value }] : [];
	});

	const ordered = reverse ? [...entries].reverse() : entries;

	if (config.style === "bubble" || config.style === "tmux") {
		return ordered
			.map(({ name, value }, index) => {
				const accent = sectionColor(name, index, config, palette);
				const textColor = config.flavor === "latte" ? palette.base : palette.base;
				const { icon, label } = splitIcon(value);

				if (config.style === "bubble") {
					return `${styled("", accent, palette.base)}${styled(` ${value} `, textColor, accent)}${styled("", accent, palette.base)}`;
				}

				const iconPart = icon ? styled(` ${icon} `, textColor, accent) : "";
				const labelPart = styled(` ${label} `, palette.text, palette.surface);
				const capBg = index === 0 ? palette.base : palette.surface;
				const leftCap = styled("", accent, capBg);
				const rightCap = index === ordered.length - 1 ? styled("", palette.surface, palette.base) : "";
				return `${leftCap}${iconPart}${labelPart}${rightCap}`;
			})
			.join(" ".repeat(Math.max(0, config.moduleSpacing)));
	}

	return ordered
		.map(({ name, value }, index) => {
			const accent = sectionColor(name, index, config, palette);
			const textColor = config.flavor === "latte" ? palette.base : palette.base;
			const isFirst = index === 0;
			const isLast = index === ordered.length - 1;
			const leftCap = isFirst ? fg(accent, "") : "";
			const { icon, label } = splitIcon(value);
			const iconPart = icon ? styled(` ${icon} `, textColor, accent) : "";
			const labelPart = styled(` ${label} `, palette.text, palette.surface);
			const rightCap = isLast ? fg(palette.surface, "") : "";
			return `${leftCap}${iconPart}${labelPart}${rightCap}`;
		})
		.join("");
}

export default function (pi: ExtensionAPI) {
	piApi = pi;
	let config = DEFAULT_CONFIG;
	let enabled = true;
	let activityState: ActivityState = "idle";
	let gitDiff: string | undefined;
	let latestFooterData: any;
	let latestStatusEntries: StatusItemEntry[] = [];
	let requestRender: (() => void) | undefined;
	let projectWatcher: FSWatcher | undefined;
	let globalWatcher: FSWatcher | undefined;

	async function refreshGitDiff(_ctx: any) {
		try {
			const result = await pi.exec("git", ["status", "--porcelain"], { timeout: 2000 });
			gitDiff = result.code === 0 ? parseGitDiff(result.stdout ?? "") : undefined;
		} catch {
			gitDiff = undefined;
		}
		requestRender?.();
	}

	function reloadConfig(ctx: any) {
		config = readConfig(ctx.cwd);
		enabled = config.enabled;
		installFooter(ctx);
		void refreshGitDiff(ctx);
	}

	function installConfigWatcher(ctx: any) {
		projectWatcher?.close();
		globalWatcher?.close();
		projectWatcher = undefined;
		globalWatcher = undefined;
		if (!config.autoReload) return;

		const projectPath = `${ctx.cwd}/${CONFIG_PATH}`;
		if (existsSync(projectPath)) {
			projectWatcher = watch(projectPath, { persistent: false }, () => {
				reloadConfig(ctx);
				requestRender?.();
			});
		}

		if (existsSync(GLOBAL_CONFIG_PATH)) {
			globalWatcher = watch(GLOBAL_CONFIG_PATH, { persistent: false }, () => {
				reloadConfig(ctx);
				requestRender?.();
			});
		}
	}

	function installFooter(ctx: any) {
		if (!enabled) {
			ctx.ui.setFooter(undefined);
			return;
		}

		ctx.ui.setFooter((tui: any, _theme: any, footerData: any) => {
			latestFooterData = footerData;
			latestStatusEntries = getStatusItemEntries(footerData);
			requestRender = () => tui.requestRender();
			const unsubscribe =
				footerData.onBranchChange?.(() => {
					void refreshGitDiff(ctx);
					tui.requestRender();
				}) ?? (() => {});
			const timer = setInterval(() => {
				void refreshGitDiff(ctx);
				tui.requestRender();
			}, 30_000);

			return {
				dispose() {
					unsubscribe();
					clearInterval(timer);
					if (requestRender) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					if (!config.enabled) return [""];

					latestStatusEntries = getStatusItemEntries(footerData);
					const palette = PALETTES[config.flavor] ?? PALETTES.mocha;
					const left = renderSegments(config.left, ctx, footerData, config, activityState, gitDiff);
					const right = renderSegments(config.right, ctx, footerData, config, activityState, gitDiff, true);
					const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
					const line = bg(palette.base, left + " ".repeat(gap) + right);
					return [truncateToWidth(line, width, "")];
				},
			};
		});

		installConfigWatcher(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		reloadConfig(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		activityState = "thinking";
		requestRender?.();
		void refreshGitDiff(ctx);
	});

	pi.on("tool_execution_start", async (_event, _ctx) => {
		activityState = "tools";
		requestRender?.();
	});

	pi.on("agent_end", async (_event, ctx) => {
		activityState = "idle";
		requestRender?.();
		void refreshGitDiff(ctx);
	});

	pi.on("session_shutdown", async () => {
		projectWatcher?.close();
		globalWatcher?.close();
		projectWatcher = undefined;
		globalWatcher = undefined;
	});

	function configPath(ctx: any, global: boolean): { path: string; displayPath: string; dir: string } {
		return global
			? {
					path: GLOBAL_CONFIG_PATH,
					displayPath: GLOBAL_CONFIG_PATH,
					dir: GLOBAL_CONFIG_PATH.slice(0, GLOBAL_CONFIG_PATH.lastIndexOf("/")),
				}
			: { path: `${ctx.cwd}/${CONFIG_PATH}`, displayPath: CONFIG_PATH, dir: `${ctx.cwd}/.pi` };
	}

	function writeConfig(ctx: any, global: boolean, nextConfig: FooterConfig): string {
		const { path, displayPath, dir } = configPath(ctx, global);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
		return displayPath;
	}

	function sectionSummary(): string {
		const enabledSections = new Set([...config.left, ...config.right]);
		const disabled = SECTION_NAMES.filter((section) => !enabledSections.has(section));
		return [
			`left: ${config.left.join(", ") || "(none)"}`,
			`right: ${config.right.join(", ") || "(none)"}`,
			`off: ${disabled.join(", ") || "(none)"}`,
			`available: ${SECTION_NAMES.join(", ")}`,
		].join("\n");
	}

	function sectionSide(section: SectionName): SectionSide | undefined {
		if (config.left.includes(section)) return "left";
		if (config.right.includes(section)) return "right";
		return undefined;
	}

	async function interactiveSectionConfig(ctx: any, globalFlag: boolean) {
		let writeGlobal = globalFlag;

		while (true) {
			const sectionLabels = new Map<string, SectionName>();
			const items = [
				`Save to ${writeGlobal ? "global" : "project"} config and close`,
				`Switch target to ${writeGlobal ? "project" : "global"} config`,
				"Cancel",
				"--- Sections ---",
			];

			refreshLatestStatusEntries();
			for (const section of SECTION_NAMES) {
				const side = sectionSide(section);
				const statusHint = section === "status" ? `, ${latestStatusEntries.length} items` : "";
				const label = `${side ? "✓" : "○"} ${section}${side ? ` (${side}${statusHint})` : " (off)"}`;
				items.push(label);
				sectionLabels.set(label, section);
			}

			const selected = await ctx.ui.select("Catppuccin footer sections", items);
			if (!selected || selected === "Cancel") return;

			if (selected.startsWith("Save to ")) {
				const displayPath = writeConfig(ctx, writeGlobal, config);
				reloadConfig(ctx);
				requestRender?.();
				ctx.ui.notify(`Updated ${displayPath}\n${sectionSummary()}`, "info");
				return;
			}

			if (selected.startsWith("Switch target")) {
				writeGlobal = !writeGlobal;
				continue;
			}

			const section = sectionLabels.get(selected);
			if (!section) continue;

			const side = sectionSide(section);
			const actions = side
				? [`Turn ${section} off`, `Move ${section} to left`, `Move ${section} to right`, "Back"]
				: [`Turn ${section} on left`, `Turn ${section} on right`, "Back"];
			if (section === "status") actions.splice(actions.length - 1, 0, "Filter status items");
			const action = await ctx.ui.select(`Configure ${section}`, actions);
			if (!action || action === "Back") continue;

			if (action === "Filter status items") {
				await interactiveStatusConfig(ctx, writeGlobal);
				continue;
			}

			if (action.endsWith("off")) config = configureSection(config, "off", section);
			else if (action.endsWith("left")) config = configureSection(config, "on", section, "left");
			else if (action.endsWith("right")) config = configureSection(config, "on", section, "right");

			enabled = config.enabled;
			installFooter(ctx);
			requestRender?.();
		}
	}

	function refreshLatestStatusEntries() {
		if (latestFooterData) latestStatusEntries = getStatusItemEntries(latestFooterData);
	}

	function statusFilterSummary(): string {
		refreshLatestStatusEntries();
		return [
			`include: ${config.statusItems.include.join(", ") || "(all)"}`,
			`exclude: ${config.statusItems.exclude.join(", ") || "(none)"}`,
			`current: ${latestStatusEntries.map((entry) => `${entry.key}=${entry.text}`).join("  ") || "(none observed yet)"}`,
		].join("\n");
	}

	function helpText(ctx: any): string {
		const projectConfig = `${ctx.cwd}/${CONFIG_PATH}`;
		return [
			"Catppuccin footer commands",
			"",
			"Basics",
			"  /catppuccin-footer                         toggle the footer on/off",
			"  /catppuccin-footer edit                    interactive config menu",
			"  /catppuccin-footer on|off                  enable or disable the footer",
			"  /catppuccin-footer reload                  reload JSON config",
			"  /catppuccin-footer help                    show this help",
			"",
			"Config files",
			`  project: ${projectConfig}`,
			`  global:  ${GLOBAL_CONFIG_PATH}`,
			"  /catppuccin-footer init [--force]           write default project config",
			"  /catppuccin-footer init --global [--force]  write default global config",
			"",
			"Sections",
			`  available: ${SECTION_NAMES.join(", ")}`,
			"  /catppuccin-footer sections                show enabled/disabled sections",
			"  /catppuccin-footer section                 interactive section picker",
			"  /catppuccin-footer sections edit [--global] same picker, choose save target",
			"  /catppuccin-footer section on <name> [left|right] [--global]",
			"  /catppuccin-footer section off <name> [--global]",
			"  /catppuccin-footer section toggle <name> [left|right] [--global]",
			"",
			"Plugin/extension status items",
			"  /catppuccin-footer status                  interactive status item picker",
			"  /catppuccin-footer status list             show filters and observed items",
			"  /catppuccin-footer status hide <pattern>   exclude matching status items",
			"  /catppuccin-footer status show <pattern>   remove a hide/show rule; allow if in allow-list mode",
			"  /catppuccin-footer status only <pattern>   allow-list only matching items",
			"  /catppuccin-footer status include <pattern> add an allow-list pattern",
			"  /catppuccin-footer status exclude <pattern> add an exclude pattern",
			"  /catppuccin-footer status reset [pattern]  clear all filters or rules for one pattern",
			"  Patterns match status key, text, or key:text; case-insensitive; * wildcards work.",
			"  Exclude wins. Empty include means show all non-excluded items.",
			"",
			"Config features",
			"  flavor: latte | frappe | macchiato | mocha",
			"  style: tmux | twoTone | bubble",
			"  cwdStyle: short | basename | full",
			"  left/right: ordered section arrays",
			"  colors: per-section Catppuccin accent overrides",
			"  aliases: model id display aliases",
			"  statusItems.include/exclude: plugin status filtering",
			"  autoReload: watch config files and refresh automatically",
			"",
			"Current state",
			sectionSummary(),
			statusFilterSummary(),
		].join("\n");
	}

	async function interactiveMainConfig(ctx: any, globalFlag: boolean) {
		while (true) {
			refreshLatestStatusEntries();
			const statusPreview = latestStatusEntries.length
				? latestStatusEntries.map((entry) => entry.key).join(", ")
				: "none observed yet";
			const choice = await ctx.ui.select("Catppuccin footer", [
				"Edit sections",
				`Filter plugin/status items (${statusPreview})`,
				"Show current section layout",
				"Show current status filters",
				"Help",
				"Cancel",
			]);
			if (!choice || choice === "Cancel") return;

			if (choice === "Edit sections") await interactiveSectionConfig(ctx, globalFlag);
			else if (choice.startsWith("Filter plugin/status items")) await interactiveStatusConfig(ctx, globalFlag);
			else if (choice === "Show current section layout") ctx.ui.notify(sectionSummary(), "info");
			else if (choice === "Show current status filters") ctx.ui.notify(statusFilterSummary(), "info");
			else if (choice === "Help") ctx.ui.notify(helpText(ctx), "info");
		}
	}

	async function interactiveStatusConfig(ctx: any, globalFlag: boolean) {
		let writeGlobal = globalFlag;

		while (true) {
			refreshLatestStatusEntries();
			const statusLabels = new Map<string, StatusItemEntry>();
			const items = [
				`Save to ${writeGlobal ? "global" : "project"} config and close`,
				`Switch target to ${writeGlobal ? "project" : "global"} config`,
				"Clear all status filters",
				"Cancel",
				`--- include: ${config.statusItems.include.join(", ") || "all"}; exclude: ${config.statusItems.exclude.join(", ") || "none"} ---`,
			];

			if (latestStatusEntries.length === 0) {
				items.push("No current status items observed yet");
			} else {
				for (const entry of latestStatusEntries) {
					const visible = statusItemVisible(entry, config.statusItems);
					const marker = visible ? (config.statusItems.include.length > 0 ? "★" : "✓") : "⊘";
					const label = `${marker} ${entry.key} — ${entry.text}`;
					items.push(label);
					statusLabels.set(label, entry);
				}
			}

			const selected = await ctx.ui.select("Catppuccin footer status items", items);
			if (!selected || selected === "Cancel") return;

			if (selected.startsWith("Save to ")) {
				const displayPath = writeConfig(ctx, writeGlobal, config);
				reloadConfig(ctx);
				requestRender?.();
				ctx.ui.notify(`Updated ${displayPath}\n${statusFilterSummary()}`, "info");
				return;
			}

			if (selected.startsWith("Switch target")) {
				writeGlobal = !writeGlobal;
				continue;
			}

			if (selected === "Clear all status filters") {
				config = configureStatusFilter(config, "reset");
				requestRender?.();
				continue;
			}

			const entry = statusLabels.get(selected);
			if (!entry) continue;

			const actions = [
				`Hide ${entry.key}`,
				`Show ${entry.key}`,
				`Only show ${entry.key}`,
				`Clear rules for ${entry.key}`,
				"Back",
			];
			const action = await ctx.ui.select(`Configure status ${entry.key}`, actions);
			if (!action || action === "Back") continue;

			if (action.startsWith("Hide ")) config = configureStatusFilter(config, "hide", entry.key);
			else if (action.startsWith("Show ")) config = configureStatusFilter(config, "show", entry.key);
			else if (action.startsWith("Only show ")) config = configureStatusFilter(config, "only", entry.key);
			else if (action.startsWith("Clear rules")) config = configureStatusFilter(config, "reset", entry.key);

			requestRender?.();
		}
	}

	const catppuccinFooterHandler = async (args: string, ctx: any) => {
		const command = args.trim();
		const tokens = command.split(/\s+/).filter(Boolean);
		const globalFlag = tokens.includes("--global");
		const positional = tokens.filter((token) => token !== "--global" && token !== "--force");

		if (command === "help" || command === "--help" || command === "-h") {
			ctx.ui.notify(helpText(ctx), "info");
			return;
		}

		if (
			command === "init" ||
			command === "init --force" ||
			command === "init --global" ||
			command === "init --global --force"
		) {
			const global = command.includes("--global");
			const { path, displayPath, dir } = configPath(ctx, global);
			const force = command.endsWith("--force");

			if (existsSync(path) && !force) {
				const overwrite = await ctx.ui.confirm(
					"Overwrite Catppuccin footer config?",
					`${displayPath} already exists. Replace it with the default config?`,
				);
				if (!overwrite) return;
			}

			mkdirSync(dir, { recursive: true });
			writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
			reloadConfig(ctx);
			ctx.ui.notify(`Wrote ${displayPath}`, "info");
			return;
		}

		if (command === "reload") {
			reloadConfig(ctx);
			ctx.ui.notify("Catppuccin footer config reloaded", "info");
			return;
		}

		if (positional[0] === "edit") {
			await interactiveMainConfig(ctx, globalFlag);
			return;
		}

		if (command === "sections" || command === "sections --global") {
			ctx.ui.notify(sectionSummary(), "info");
			return;
		}

		if (positional[0] === "sections" && positional[1] === "edit") {
			await interactiveSectionConfig(ctx, globalFlag);
			return;
		}

		if (positional[0] === "section" && positional.length === 1) {
			await interactiveSectionConfig(ctx, globalFlag);
			return;
		}

		if (positional[0] === "section") {
			const action = positional[1];
			const section = positional[2];
			const side = positional[3];

			if ((action !== "on" && action !== "off" && action !== "toggle") || !section || !isSectionName(section)) {
				ctx.ui.notify(
					`Usage: /catppuccin-footer section <on|off|toggle> <${SECTION_NAMES.join("|")}> [left|right] [--global]`,
					"warning",
				);
				return;
			}

			if (side !== undefined && side !== "left" && side !== "right") {
				ctx.ui.notify("Section side must be left or right", "warning");
				return;
			}

			const sectionSide = side as SectionSide | undefined;
			config = configureSection(config, action, section, sectionSide);
			enabled = config.enabled;
			const displayPath = writeConfig(ctx, globalFlag, config);
			installFooter(ctx);
			requestRender?.();
			ctx.ui.notify(`Updated ${displayPath}\n${sectionSummary()}`, "info");
			return;
		}

		if (positional[0] === "status") {
			const action = positional[1];
			const pattern = positional.slice(2).join(" ");

			if (!action || action === "edit") {
				await interactiveStatusConfig(ctx, globalFlag);
				return;
			}

			if (action === "list") {
				ctx.ui.notify(statusFilterSummary(), "info");
				return;
			}

			if (action === "reset" && (!pattern || pattern === "all")) {
				config = configureStatusFilter(config, "reset");
			} else if (
				(action === "reset" ||
					action === "hide" ||
					action === "show" ||
					action === "only" ||
					action === "include" ||
					action === "exclude") &&
				pattern
			) {
				const filterAction = action === "include" ? "allow" : action === "exclude" ? "hide" : action;
				config = configureStatusFilter(config, filterAction, pattern);
			} else {
				ctx.ui.notify(
					"Usage: /catppuccin-footer status [edit|list|hide|show|only|include|exclude|reset] [pattern] [--global]",
					"warning",
				);
				return;
			}

			const displayPath = writeConfig(ctx, globalFlag, config);
			requestRender?.();
			ctx.ui.notify(`Updated ${displayPath}\n${statusFilterSummary()}`, "info");
			return;
		}

		enabled = command === "on" ? true : command === "off" ? false : !enabled;
		installFooter(ctx);
		ctx.ui.notify(`Catppuccin footer ${enabled ? "enabled" : "disabled"}`, "info");
	};

	pi.registerCommand("catppuccin-footer", {
		description: "Toggle, configure, initialize, or get help for the Catppuccin-style configurable footer",
		handler: catppuccinFooterHandler,
	});
}
