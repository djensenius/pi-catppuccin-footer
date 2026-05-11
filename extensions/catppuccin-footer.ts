import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, relative } from "node:path";

const CONFIG_PATH = ".pi/catppuccin-footer.json";
const GLOBAL_CONFIG_PATH = `${process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`}/catppuccin-footer.json`;

type Flavor = "latte" | "frappe" | "macchiato" | "mocha";
type ColorName = "mauve" | "blue" | "green" | "yellow" | "peach" | "pink" | "surface" | "muted" | "text";
type SectionName =
	| "mode"
	| "cwd"
	| "git"
	| "gitDiff"
	| "status"
	| "state"
	| "model"
	| "tokens"
	| "lastTokens"
	| "cost"
	| "time"
	| "thinking";
type CwdStyle = "short" | "basename" | "full";
type SegmentStyle = "twoTone" | "bubble" | "tmux";
type ActivityState = "idle" | "thinking" | "tools";

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

export function readConfig(cwd: string): FooterConfig {
	const globalRaw = readJsonConfig(GLOBAL_CONFIG_PATH);
	const projectRaw = readJsonConfig(`${cwd}/${CONFIG_PATH}`);
	const merged = { ...globalRaw, ...projectRaw };

	return {
		...DEFAULT_CONFIG,
		...merged,
		left: Array.isArray(merged.left) ? merged.left : DEFAULT_CONFIG.left,
		right: Array.isArray(merged.right) ? merged.right : DEFAULT_CONFIG.right,
		colors: { ...DEFAULT_CONFIG.colors, ...(globalRaw.colors ?? {}), ...(projectRaw.colors ?? {}) },
		aliases: { ...DEFAULT_CONFIG.aliases, ...(globalRaw.aliases ?? {}), ...(projectRaw.aliases ?? {}) },
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
			const statuses = footerData.getExtensionStatuses?.();
			if (!statuses || statuses.size === 0) return undefined;
			return [...statuses.values()].filter(Boolean).join("  ");
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
	const entries = names
		.map((name) => ({ name, value: sectionValue(name, ctx, footerData, config, activityState, gitDiff) }))
		.filter((entry): entry is { name: SectionName; value: string } => Boolean(entry.value));

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

	const catppuccinFooterHandler = async (args: string, ctx: any) => {
		const command = args.trim();

		if (
			command === "init" ||
			command === "init --force" ||
			command === "init --global" ||
			command === "init --global --force"
		) {
			const global = command.includes("--global");
			const path = global ? GLOBAL_CONFIG_PATH : `${ctx.cwd}/${CONFIG_PATH}`;
			const displayPath = global ? GLOBAL_CONFIG_PATH : CONFIG_PATH;
			const force = command.endsWith("--force");

			if (existsSync(path) && !force) {
				const overwrite = await ctx.ui.confirm(
					"Overwrite Catppuccin footer config?",
					`${displayPath} already exists. Replace it with the default config?`,
				);
				if (!overwrite) return;
			}

			mkdirSync(global ? GLOBAL_CONFIG_PATH.slice(0, GLOBAL_CONFIG_PATH.lastIndexOf("/")) : `${ctx.cwd}/.pi`, {
				recursive: true,
			});
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

		enabled = command === "on" ? true : command === "off" ? false : !enabled;
		installFooter(ctx);
		ctx.ui.notify(`Catppuccin footer ${enabled ? "enabled" : "disabled"}`, "info");
	};

	pi.registerCommand("catppuccin-footer", {
		description: "Toggle, initialize, or reload the Catppuccin-style configurable footer",
		handler: catppuccinFooterHandler,
	});
}
